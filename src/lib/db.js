/**
 * Persistência em SQLite usando o módulo nativo node:sqlite (Node >= 22.5).
 * Tabelas:
 *   scans        — uma linha por execução de varredura
 *   devices      — um registro por IP (o "inventário" atual)
 *   ports        — portas abertas por dispositivo (histórico por scan_id)
 *   sip_info     — identidade SIP coletada (server/user-agent/methods)
 *   events       — mudanças de estado (novo, sumiu, porta abriu/fechou)
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dbPath) {
  const dir = path.dirname(path.resolve(dbPath));
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    TEXT    NOT NULL,
      finished_at   TEXT,
      targets       TEXT    NOT NULL,
      options_json  TEXT,
      state         TEXT    NOT NULL DEFAULT 'running',
      hosts_scanned INTEGER DEFAULT 0,
      hosts_alive   INTEGER DEFAULT 0,
      phones_found  INTEGER DEFAULT 0,
      error         TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
      ip            TEXT PRIMARY KEY,
      first_seen    TEXT    NOT NULL,
      last_seen     TEXT    NOT NULL,
      mac           TEXT,
      hostname      TEXT,
      vendor        TEXT,
      model         TEXT,
      device_type   TEXT,
      confidence    INTEGER,
      sip_server    TEXT,
      sip_user_agent TEXT,
      sip_methods   TEXT,
      http_server   TEXT,
      http_title    TEXT,
      ports_json    TEXT,
      http_json     TEXT,
      tls_json      TEXT,
      notes         TEXT,
      is_phone      INTEGER DEFAULT 0,
      ramal         TEXT,
      firmware      TEXT,
      serial        TEXT,
      sip_ua        TEXT,
      online        INTEGER
    );

    CREATE TABLE IF NOT EXISTS ports (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id    INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      ip         TEXT    NOT NULL,
      port       INTEGER NOT NULL,
      proto      TEXT    NOT NULL,
      service    TEXT,
      state      TEXT    DEFAULT 'open',
      banner     TEXT,
      latency_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS sip_info (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id     INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      ip          TEXT    NOT NULL,
      transport   TEXT,
      status_code INTEGER,
      server      TEXT,
      user_agent  TEXT,
      allow       TEXT,
      raw         TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id    INTEGER NOT NULL,
      ip         TEXT    NOT NULL,
      event      TEXT    NOT NULL,
      detail     TEXT,
      created_at TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ports_scan ON ports(scan_id);
    CREATE INDEX IF NOT EXISTS idx_ports_ip   ON ports(ip);
    CREATE INDEX IF NOT EXISTS idx_sip_scan   ON sip_info(scan_id);
    CREATE INDEX IF NOT EXISTS idx_events_ip  ON events(ip);

    CREATE VIEW IF NOT EXISTS v_phones AS
      SELECT ip, first_seen, last_seen, mac, hostname, vendor, model, device_type,
             confidence, sip_server, sip_user_agent, http_server, ports_json
      FROM devices
      WHERE is_phone = 1
      ORDER BY ip;
  `);

  // migrações aditivas para bancos criados por versões anteriores
  const cols = db.prepare(`PRAGMA table_info(devices)`).all().map((r) => r.name);
  const addColumn = (name, type) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE devices ADD COLUMN ${name} ${type}`);
  };
  addColumn('tls_json', 'TEXT');
  addColumn('ramal', 'TEXT');
  addColumn('firmware', 'TEXT');
  addColumn('serial', 'TEXT');
  addColumn('sip_ua', 'TEXT');
  addColumn('online', 'INTEGER');
  addColumn('missing_since', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_devices_ramal ON devices(ramal);
    CREATE TABLE IF NOT EXISTS monitor_runs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      checked    INTEGER DEFAULT 0,
      online     INTEGER DEFAULT 0,
      offline    INTEGER DEFAULT 0,
      with_ramal INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS monitor_samples (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     INTEGER NOT NULL,
      ip         TEXT NOT NULL,
      online     INTEGER NOT NULL,
      ramal      TEXT,
      firmware   TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_samples_run ON monitor_samples(run_id);
    CREATE INDEX IF NOT EXISTS idx_samples_ip  ON monitor_samples(ip);
    CREATE INDEX IF NOT EXISTS idx_samples_time ON monitor_samples(created_at);
  `);

  // -------------------------------------------------------------------
  // CACHE MATERIALIZADO das agregacoes.
  //
  // As views v_estabilidade (window functions) e v_quedas custam ~650ms e
  // ~500ms por avaliacao sobre 100k+ amostras, e eram reavaliadas a cada
  // requisicao. Estas tabelas guardam o RESULTADO, recalculado uma vez por
  // ciclo de monitoramento (refreshStats). A leitura passa a ser O(1).
  //
  // As views continuam sendo a unica fonte da regra de negocio; as tabelas
  // sao derivadas delas — se a regra mudar, so a view muda.
  // -------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_stats (
      ip                TEXT PRIMARY KEY,
      ramal             TEXT,
      amostras          INTEGER NOT NULL DEFAULT 0,
      amostras_offline  INTEGER NOT NULL DEFAULT 0,
      amostras_online   INTEGER NOT NULL DEFAULT 0,
      pct_indisponivel  REAL,
      quedas            INTEGER NOT NULL DEFAULT 0,
      em_queda          INTEGER NOT NULL DEFAULT 0,
      em_instabilidade  INTEGER NOT NULL DEFAULT 0,
      primeira_falha    TEXT,
      ultima_falha      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stats_inst ON device_stats(em_instabilidade);
    CREATE INDEX IF NOT EXISTS idx_stats_queda ON device_stats(em_queda);

    CREATE TABLE IF NOT EXISTS drop_episodes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ip              TEXT NOT NULL,
      inicio          TEXT NOT NULL,
      retorno         TEXT,
      coletas_offline INTEGER NOT NULL DEFAULT 0,
      duracao_min     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ep_ip   ON drop_episodes(ip);
    CREATE INDEX IF NOT EXISTS idx_ep_ini  ON drop_episodes(inicio);
    CREATE INDEX IF NOT EXISTS idx_ep_aberto ON drop_episodes(retorno);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Indicadores de estabilidade (historico de amostras).
  // em_instabilidade: ja respondeu e depois caiu >= 1 vez — separa equipamento
  // intermitente de aparelho que simplesmente nunca subiu.
  db.exec(`
    DROP VIEW IF EXISTS v_estabilidade;
    CREATE VIEW v_estabilidade AS
    WITH base AS (
      SELECT ip,
             COUNT(*)                                      AS amostras,
             SUM(CASE WHEN online = 0 THEN 1 ELSE 0 END)   AS amostras_offline,
             SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END)   AS amostras_online,
             MIN(CASE WHEN online = 0 THEN created_at END) AS primeira_falha,
             MAX(CASE WHEN online = 0 THEN created_at END) AS ultima_falha
      FROM monitor_samples GROUP BY ip
    ),
    q_ord AS (
      SELECT ip, created_at, online,
             LAG(online) OVER (PARTITION BY ip ORDER BY created_at) AS anterior
      FROM monitor_samples
    ),
    q AS (
      SELECT ip,
             SUM(CASE WHEN online = 0 AND (anterior IS NULL OR anterior = 1) THEN 1 ELSE 0 END) AS quedas
      FROM q_ord GROUP BY ip
    ),
    ultimo AS (
      SELECT ms.ip, ms.online
      FROM monitor_samples ms
      JOIN (SELECT ip, MAX(id) AS ult_id FROM monitor_samples GROUP BY ip) u
        ON u.ip = ms.ip AND u.ult_id = ms.id
    )
    SELECT b.ip,
           d.ramal,
           b.amostras,
           b.amostras_offline,
           b.amostras_online,
           CASE WHEN b.amostras > 0
                THEN ROUND(100.0 * b.amostras_offline / b.amostras, 1) END AS pct_indisponivel,
           q.quedas,
           CASE WHEN ult.online = 0 THEN 1 ELSE 0 END AS em_queda,
           CASE WHEN b.amostras_online >= 2 AND q.quedas >= 1 THEN 1 ELSE 0 END AS em_instabilidade,
           b.primeira_falha,
           b.ultima_falha
    FROM base b
    JOIN q     ON q.ip = b.ip
    JOIN ultimo ult ON ult.ip = b.ip
    LEFT JOIN devices d ON d.ip = b.ip;
  `);

  // Historico de quedas agrupado em episodios (sequencia continua offline).
  // Uma hora fora do ar vira 1 linha, nao 4.
  db.exec(`
    DROP VIEW IF EXISTS v_quedas;
    CREATE VIEW v_quedas AS
    WITH passo AS (
      SELECT ip, created_at, online,
             LAG(online) OVER (PARTITION BY ip ORDER BY created_at) AS anterior
      FROM monitor_samples
    ),
    marcado AS (
      SELECT ip, created_at, online,
             CASE WHEN online = 0 AND (anterior IS NULL OR anterior = 1) THEN 1 ELSE 0 END AS abre
      FROM passo
    ),
    numerado AS (
      SELECT ip, created_at, online,
             SUM(abre) OVER (PARTITION BY ip ORDER BY created_at
                             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ep
      FROM marcado
    )
    SELECT n.ip, d.ramal, n.ep,
           MIN(CASE WHEN n.online = 0 THEN n.created_at END) AS inicio,
           MIN(CASE WHEN n.online = 1 THEN n.created_at END) AS retorno,
           SUM(CASE WHEN n.online = 0 THEN 1 ELSE 0 END)     AS coletas_offline,
           CASE
             WHEN MIN(CASE WHEN n.online = 1 THEN n.created_at END) IS NULL THEN NULL
             ELSE CAST(ROUND((julianday(MIN(CASE WHEN n.online = 1 THEN n.created_at END))
                        - julianday(MIN(CASE WHEN n.online = 0 THEN n.created_at END))) * 24 * 60) AS INTEGER)
           END AS duracao_min
    FROM numerado n
    LEFT JOIN devices d ON d.ip = n.ip
    GROUP BY n.ip, n.ep
    HAVING SUM(CASE WHEN n.online = 0 THEN 1 ELSE 0 END) > 0
    ORDER BY inicio DESC;
  `);
}

/** Historico de quedas (episodios) — filtros opcionais por ip e janela em horas. */
export function listarQuedas(db, { ip = null, horas = null, limite = 500 } = {}) {
  const cond = [];
  const args = [];
  if (ip) { cond.push('e.ip = ?'); args.push(ip); }
  if (horas) {
    cond.push('e.inicio >= ?');
    args.push(new Date(Date.now() - horas * 3600000).toISOString());
  }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  args.push(Math.min(2000, Number(limite) || 500));
  // le da tabela materializada; ramal vem de devices (a tabela guarda so o ip)
  return db.prepare(
    `SELECT e.ip, e.inicio, e.retorno, e.coletas_offline, e.duracao_min,
            d.ramal
     FROM drop_episodes e
     LEFT JOIN devices d ON d.ip = e.ip
     ${where}
     ORDER BY e.inicio DESC LIMIT ?`,
  ).all(...args);
}

/** Resumo do historico de quedas de um telefone. */
export function resumoQuedas(db, ip) {
  return db.prepare(
    `SELECT COUNT(*) episodios,
            IFNULL(SUM(coletas_offline), 0) coletas,
            IFNULL(SUM(duracao_min), 0) minutos,
            MAX(duracao_min) maior,
            SUM(CASE WHEN retorno IS NULL THEN 1 ELSE 0 END) abertos,
            MAX(inicio) ultima
     FROM drop_episodes WHERE ip = ?`,
  ).get(ip);
}

/** Le um valor da tabela meta. */
export function getMeta(db, key) {
  return db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key)?.value ?? null;
}

/**
 * Recalcula as tabelas materializadas a partir das views.
 *
 * Deve rodar UMA vez por ciclo de monitoramento, depois de inserir as
 * amostras. Usa transacao unica para que nenhum leitor veja a tabela
 * pela metade (DELETE + INSERT).
 *
 * @returns {{ ms:number, devices:number, episodios:number }}
 */
export function refreshStats(db) {
  const t0 = Date.now();
  const agora = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM device_stats');
    db.exec(`
      INSERT INTO device_stats
        (ip, ramal, amostras, amostras_offline, amostras_online,
         pct_indisponivel, quedas, em_queda, em_instabilidade,
         primeira_falha, ultima_falha)
      SELECT ip, ramal, amostras, amostras_offline, amostras_online,
             pct_indisponivel, quedas, em_queda, em_instabilidade,
             primeira_falha, ultima_falha
      FROM v_estabilidade
    `);

    db.exec('DELETE FROM drop_episodes');
    db.exec(`
      INSERT INTO drop_episodes (ip, inicio, retorno, coletas_offline, duracao_min)
      SELECT ip, inicio, retorno, coletas_offline, duracao_min
      FROM v_quedas
      ORDER BY inicio
    `);

    db.prepare(`INSERT INTO meta (key, value) VALUES ('stats_at', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(agora);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    ms: Date.now() - t0,
    devices: db.prepare(`SELECT COUNT(*) c FROM device_stats`).get().c,
    episodios: db.prepare(`SELECT COUNT(*) c FROM drop_episodes`).get().c,
  };
}

/** true se o cache materializado esta populado. */
export function statsProntas(db) {
  return db.prepare(`SELECT COUNT(*) c FROM device_stats`).get().c > 0;
}

export function createScan(db, { targets, options }) {
  const stmt = db.prepare(
    `INSERT INTO scans (started_at, targets, options_json, state) VALUES (?, ?, ?, 'running')`,
  );
  const info = stmt.run(new Date().toISOString(), JSON.stringify(targets), JSON.stringify(options || {}));
  return Number(info.lastInsertRowid);
}

export function finishScan(db, scanId, { state, hostsScanned, hostsAlive, phonesFound, error }) {
  db.prepare(
    `UPDATE scans SET finished_at = ?, state = ?, hosts_scanned = ?, hosts_alive = ?, phones_found = ?, error = ? WHERE id = ?`,
  ).run(new Date().toISOString(), state, hostsScanned ?? 0, hostsAlive ?? 0, phonesFound ?? 0, error || null, scanId);
}

export function insertPorts(db, scanId, ip, ports) {
  const stmt = db.prepare(
    `INSERT INTO ports (scan_id, ip, port, proto, service, state, latency_ms) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  );
  for (const p of ports) stmt.run(scanId, ip, p.port, p.proto || 'tcp', p.name || null, p.ms ?? null);
}

export function insertSipInfo(db, scanId, ip, info) {
  db.prepare(
    `INSERT INTO sip_info (scan_id, ip, transport, status_code, server, user_agent, allow, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    scanId,
    ip,
    info.proto || null,
    info.data?.status ?? null,
    info.data?.server ?? null,
    info.data?.userAgent ?? null,
    info.data?.allow ?? null,
    info.raw ? info.raw.slice(0, 8000) : null,
  );
}

/**
 * Upsert de dispositivo. Retorna {isNew, changedPorts:{added, removed}}.
 */
export function upsertDevice(db, scanId, dev) {
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT * FROM devices WHERE ip = ?`).get(dev.ip);
  const portsJson = JSON.stringify(dev.openPorts.map((p) => `${p.port}/${p.proto}`));

  if (!existing) {
    db.prepare(
      `INSERT INTO devices (ip, first_seen, last_seen, mac, hostname, vendor, model, device_type, confidence,
        sip_server, sip_user_agent, sip_methods, http_server, http_title, ports_json, http_json, tls_json, notes, is_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      dev.ip, now, now, dev.mac, dev.hostname, dev.vendor, dev.model, dev.deviceType, dev.confidence,
      dev.sipServer, dev.sipUserAgent, dev.sipMethods, dev.httpServer, dev.httpTitle,
      portsJson, dev.httpJson ? JSON.stringify(dev.httpJson) : null,
      dev.tls ? JSON.stringify(dev.tls) : null, dev.notes, dev.isPhone ? 1 : 0,
    );
    logEvent(db, scanId, dev.ip, 'new', dev.deviceType || 'unknown');
    return { isNew: true, added: dev.openPorts.map((p) => `${p.port}/${p.proto}`), removed: [] };
  }

  const oldPorts = new Set(safeParse(existing.ports_json) || []);
  const newPorts = new Set(safeParse(portsJson) || []);
  const added = [...newPorts].filter((p) => !oldPorts.has(p));
  const removed = [...oldPorts].filter((p) => !newPorts.has(p));

  db.prepare(
    `UPDATE devices SET last_seen = ?, mac = COALESCE(?, mac), hostname = COALESCE(?, hostname),
       vendor = COALESCE(?, vendor), model = COALESCE(?, model), device_type = COALESCE(?, device_type),
       confidence = COALESCE(?, confidence), sip_server = COALESCE(?, sip_server),
       sip_user_agent = COALESCE(?, sip_user_agent), sip_methods = COALESCE(?, sip_methods),
       http_server = COALESCE(?, http_server), http_title = COALESCE(?, http_title),
       ports_json = ?, http_json = COALESCE(?, http_json), tls_json = COALESCE(?, tls_json),
       notes = COALESCE(?, notes), is_phone = ?
     WHERE ip = ?`,
  ).run(
    now, dev.mac, dev.hostname, dev.vendor, dev.model, dev.deviceType, dev.confidence,
    dev.sipServer, dev.sipUserAgent, dev.sipMethods, dev.httpServer, dev.httpTitle,
    portsJson, dev.httpJson ? JSON.stringify(dev.httpJson) : null,
    dev.tls ? JSON.stringify(dev.tls) : null, dev.notes, dev.isPhone ? 1 : 0, dev.ip,
  );

  if (added.length) logEvent(db, scanId, dev.ip, 'ports_opened', added.join(', '));
  if (removed.length) logEvent(db, scanId, dev.ip, 'ports_closed', removed.join(', '));
  return { isNew: false, added, removed };
}

export function logEvent(db, scanId, ip, event, detail) {
  db.prepare(`INSERT INTO events (scan_id, ip, event, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(scanId, ip, event, detail ?? null, new Date().toISOString());
}

function safeParse(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

/** Lista dispositivos marcados como telefone. */
export function listPhones(db, { all = false } = {}) {
  return db.prepare(`SELECT * FROM devices ${all ? '' : 'WHERE is_phone = 1'} ORDER BY ip`).all();
}

/** Lista todos os dispositivos vivos. */
export function listDevices(db) {
  return db.prepare(`SELECT * FROM devices ORDER BY ip`).all();
}

/**
 * Atualiza identidade SIP (ramal/modelo/firmware/serial) de um dispositivo.
 * Retorna se o ramal mudou.
 */
export function updateSipIdentity(db, ip, id) {
  const prev = db.prepare(`SELECT ramal FROM devices WHERE ip = ?`).get(ip);
  db.prepare(
    `UPDATE devices SET
       ramal = COALESCE(?, ramal), firmware = COALESCE(?, firmware),
       serial = COALESCE(?, serial), sip_ua = COALESCE(?, sip_ua),
       model = COALESCE(?, model), mac = COALESCE(?, mac), last_seen = ?
     WHERE ip = ?`,
  ).run(
    id.ramal, id.firmware, id.serial, id.ua || null,
    id.model ? `ALE ${id.model}` : null, id.mac, new Date().toISOString(), ip,
  );
  return { ramalChanged: !!prev && prev.ramal !== id.ramal && !!id.ramal, previous: prev?.ramal ?? null };
}

/** Marca status online/offline do ultimo check. */
export function setOnline(db, ip, online) {
  db.prepare(`UPDATE devices SET online = ? WHERE ip = ?`).run(online ? 1 : 0, ip);
}

/**
 * Marca presenca/ausencia de um IP na rede monitorada.
 * - online = 1: presente e respondendo
 * - online = 0: ausente na ultima varredura (desapareceu)
 * - online = NULL: nunca verificado
 * Atualiza missing_since ao transicionar presente -> ausente.
 */
export function setPresence(db, ip, online) {
  const cur = db.prepare(`SELECT online, missing_since FROM devices WHERE ip = ?`).get(ip);
  if (!cur) return { changed: false, wasOnline: false };
  const now = new Date().toISOString();
  if (online) {
    const wasMissing = cur.online === 0;
    db.prepare(`UPDATE devices SET online = 1, missing_since = NULL WHERE ip = ?`).run(ip);
    return { changed: wasMissing, wasOnline: true };
  }
  if (cur.online !== 0) {
    db.prepare(`UPDATE devices SET online = 0, missing_since = ? WHERE ip = ?`).run(now, ip);
    return { changed: true, wasOnline: cur.online === 1 };
  }
  return { changed: false, wasOnline: false };
}

/** Registra um aparelho novo descoberto durante o monitoramento. */
export function registerNewDevice(db, scanId, ip, id) {
  const now = new Date().toISOString();
  const ports = [];
  if (id.status === 200) ports.push({ port: 5060, name: 'sip-tcp', proto: 'tcp', ms: null });
  db.prepare(
    `INSERT INTO devices (ip, first_seen, last_seen, mac, hostname, vendor, model, device_type, confidence,
       sip_user_agent, ports_json, notes, is_phone, ramal, firmware, serial, sip_ua, online)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'phone', 95, ?, ?, ?, 1, ?, ?, ?, ?, 1)
     ON CONFLICT(ip) DO NOTHING`,
  ).run(
    ip, now, now, id.mac, 'Alcatel-Lucent Enterprise',
    id.model ? `ALE ${id.model}` : 'ALE IP device', id.ua || null,
    JSON.stringify(ports.map((p) => `${p.port}/${p.proto}`)),
    'descoberto no monitoramento',
    id.ramal, id.firmware, id.serial, id.ua || null,
  );
  insertPorts(db, scanId, ip, ports);
  logEvent(db, scanId, ip, 'new', `ramal ${id.ramal || '?'} descoberto no monitoramento`);
}

export function startMonitorRun(db) {
  const info = db.prepare(`INSERT INTO monitor_runs (started_at) VALUES (?)`).run(new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function finishMonitorRun(db, runId, stats) {
  db.prepare(
    `UPDATE monitor_runs SET finished_at = ?, checked = ?, online = ?, offline = ?, with_ramal = ? WHERE id = ?`,
  ).run(new Date().toISOString(), stats.checked, stats.online, stats.offline, stats.withRamal, runId);
}

export function insertSample(db, runId, ip, online, ramal, firmware) {
  db.prepare(
    `INSERT INTO monitor_samples (run_id, ip, online, ramal, firmware, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(runId, ip, online ? 1 : 0, ramal, firmware, new Date().toISOString());
}

/**
 * Remove amostras e ciclos mais antigos que N dias (default 30).
 *
 * O intervalo de coleta importa: com 15 min e 237 telefones sao ~23 mil
 * linhas/dia. 30 dias ficam em ~680 mil linhas (~100 MB), ainda folgado
 * para SQLite. Se o intervalo voltar a 1h, 30 dias sao ~170 mil linhas.
 */
export function pruneSamples(db, days = 30) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const r = db.prepare(`DELETE FROM monitor_samples WHERE created_at < ?`).run(cutoff);
  db.prepare(`DELETE FROM monitor_runs WHERE finished_at IS NOT NULL AND finished_at < ?`).run(cutoff);
  return Number(r.changes);
}

/**
 * Recupera espaco no arquivo apos poda grande (VACUUM).
 * Roda so de vez em quando: pool gratuito > 30% indica que vale compactar.
 */
export function maybeVacuum(db) {
  try {
    const freelist = db.prepare(`PRAGMA freelist_count`).get();
    const pages = db.prepare(`PRAGMA page_count`).get();
    const livre = freelist?.freelist_count ?? 0;
    const total = pages?.page_count ?? 0;
    if (total > 0 && livre / total > 0.3) {
      db.exec('VACUUM');
      return true;
    }
  } catch {
    // VACUUM pode falhar se outro processo estiver escrevendo: ignora
  }
  return false;
}

/** Ranges usados em scans de rede anteriores (exclui os ciclos de monitoramento). */
export function knownTargets(db) {
  const rows = db.prepare(`SELECT targets FROM scans WHERE targets NOT LIKE '%"monitor"%' ORDER BY id`).all();
  const set = new Set();
  for (const r of rows) {
    try {
      for (const t of JSON.parse(r.targets)) if (t !== 'monitor') set.add(t);
    } catch {
      // ignora linha invalida
    }
  }
  return [...set];
}

/** Inventario para a interface web, ja com ramal e setores. */
export function inventoryRows(db) {
  // usa LEFT JOIN com as tabelas de setores (podem nao existir ainda)
  const temSetores = db.prepare(
    `SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='setor_ramais'`,
  ).get().c > 0;

  if (!temSetores) {
    return db.prepare(
      `SELECT d.ip, d.mac, d.hostname, d.vendor, d.model, d.device_type, d.ramal, d.firmware,
              d.serial, d.sip_ua, d.http_server, d.ports_json, d.tls_json, d.first_seen,
              d.last_seen, d.online, d.missing_since,
              NULL AS setores, NULL AS qtd_setores, NULL AS andares, NULL AS alas,
              e.quedas, e.pct_indisponivel, e.em_instabilidade, e.em_queda,
              e.amostras, e.amostras_offline, e.primeira_falha, e.ultima_falha
       FROM devices d
       LEFT JOIN device_stats e ON e.ip = d.ip
       WHERE d.is_phone = 1
       ORDER BY CAST(d.ramal AS INTEGER) IS NULL, CAST(d.ramal AS INTEGER), d.ip`,
    ).all();
  }

  return db.prepare(
    `SELECT d.ip, d.mac, d.hostname, d.vendor, d.model, d.device_type, d.ramal, d.firmware,
            d.serial, d.sip_ua, d.http_server, d.ports_json, d.tls_json, d.first_seen,
            d.last_seen, d.online, d.missing_since,
            (SELECT GROUP_CONCAT(s.setor, ' | ')
               FROM setor_ramais sr JOIN setores s ON s.id = sr.setor_id
              WHERE sr.ramal_curto = substr(d.ramal, 3))               AS setores,
            (SELECT COUNT(*)
               FROM setor_ramais sr
              WHERE sr.ramal_curto = substr(d.ramal, 3))               AS qtd_setores,
            (SELECT GROUP_CONCAT(IFNULL(s.andar, ''), ' | ')
               FROM setor_ramais sr JOIN setores s ON s.id = sr.setor_id
              WHERE sr.ramal_curto = substr(d.ramal, 3))               AS andares,
            (SELECT GROUP_CONCAT(IFNULL(s.ala, ''), ' | ')
               FROM setor_ramais sr JOIN setores s ON s.id = sr.setor_id
              WHERE sr.ramal_curto = substr(d.ramal, 3))               AS alas,
            e.quedas, e.pct_indisponivel, e.em_instabilidade, e.em_queda,
            e.amostras, e.amostras_offline, e.primeira_falha, e.ultima_falha
     FROM devices d
     LEFT JOIN device_stats e ON e.ip = d.ip
     WHERE d.is_phone = 1
     ORDER BY CAST(d.ramal AS INTEGER) IS NULL, CAST(d.ramal AS INTEGER), d.ip`,
  ).all();
}

/** Resumo de estabilidade para os cards da interface. */
export function estabilidadeResumo(db) {
  const one = (sql) => db.prepare(sql).get().c;
  return {
    comHistorico: one(`SELECT COUNT(*) c FROM device_stats`),
    instaveis: one(`SELECT COUNT(*) c FROM device_stats WHERE em_instabilidade = 1`),
    emQueda: one(`SELECT COUNT(*) c FROM device_stats WHERE em_queda = 1`),
    totalQuedas: one(`SELECT IFNULL(SUM(quedas), 0) c FROM device_stats`),
    pior: db.prepare(
      `SELECT e.ip, d.ramal, e.quedas, e.pct_indisponivel
       FROM device_stats e LEFT JOIN devices d ON d.ip = e.ip
       WHERE e.em_instabilidade = 1
       ORDER BY e.pct_indisponivel DESC LIMIT 1`,
    ).get() || null,
  };
}

/** Lista de setores distintos com contagem de ramais e telefones. */
export function setoresResumo(db) {
  const tem = db.prepare(
    `SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='setores'`,
  ).get().c > 0;
  if (!tem) return [];
  return db.prepare(
    `SELECT s.setor, s.andar, s.predio, s.ala,
            COUNT(DISTINCT sr.ramal_curto) AS ramais
     FROM setores s
     LEFT JOIN setor_ramais sr ON sr.setor_id = s.id
     GROUP BY s.id
     ORDER BY s.setor`,
  ).all();
}

/* =====================================================================
 * EDIÇÃO DE SETORES  (vinculo ramal <-> setor)
 * ===================================================================== */

/** Normaliza o ramal para 4 digitos (aceita 402300, 2300). */
export function ramalCurto(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 6 && (d.startsWith('40') || d.startsWith('41'))) return d.slice(2);
  if (d.length === 4) return d;
  return null;
}

/** Todos os setores cadastrados, com contagem de ramais. */
export function listarSetores(db) {
  return db.prepare(
    `SELECT s.id, s.setor, s.andar, s.predio, s.ala, s.origem,
            (SELECT COUNT(*) FROM setor_ramais sr WHERE sr.setor_id = s.id) AS ramais
     FROM setores s
     ORDER BY s.setor, IFNULL(s.andar, '')`,
  ).all();
}

/** Setores vinculados a um ramal (com o id do vinculo para remocao). */
export function setoresDoRamal(db, ramal) {
  const curto = ramalCurto(ramal);
  if (!curto) return [];
  return db.prepare(
    `SELECT sr.id AS vinculo_id, s.id AS setor_id, s.setor, s.andar, s.predio, s.ala, s.origem
     FROM setor_ramais sr JOIN setores s ON s.id = sr.setor_id
     WHERE sr.ramal_curto = ?
     ORDER BY s.setor`,
  ).all(curto);
}

/**
 * Vincula um ramal a um setor.
 * - setorId informado: usa o setor existente.
 * - caso contrario: cria o setor (reusa se nome+andar ja existirem).
 */
export function vincularSetor(db, { ramal, setorId, setor, andar, predio, ala, fonte = 'manual' }) {
  const curto = ramalCurto(ramal);
  if (!curto) return { ok: false, erro: 'ramal invalido (informe 4 ou 6 digitos)' };

  const dev = db.prepare(`SELECT ip, ramal FROM devices WHERE substr(ramal, 3) = ? OR ramal = ?`).get(curto, ramal);
  if (!dev) return { ok: false, erro: `ramal ${curto} nao existe no inventario` };

  let id = Number(setorId) || null;
  let criado = false;

  if (!id) {
    const nome = String(setor || '').trim();
    if (!nome) return { ok: false, erro: 'informe o nome do setor' };
    const and = String(andar || '').trim() || null;
    const ex = db.prepare(
      `SELECT id FROM setores WHERE setor = ? AND IFNULL(andar,'') = IFNULL(?,'') LIMIT 1`,
    ).get(nome, and);
    if (ex) {
      id = ex.id;
    } else {
      const info = db.prepare(
        `INSERT INTO setores (setor, andar, predio, ala, origem, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(nome, and, String(predio || '').trim() || null, String(ala || '').trim() || null,
        fonte, new Date().toISOString());
      id = Number(info.lastInsertRowid);
      criado = true;
    }
  } else {
    const existe = db.prepare(`SELECT id FROM setores WHERE id = ?`).get(id);
    if (!existe) return { ok: false, erro: 'setor informado nao existe' };
  }

  const ja = db.prepare(`SELECT id FROM setor_ramais WHERE setor_id = ? AND ramal_curto = ?`).get(id, curto);
  if (ja) return { ok: true, setorId: id, criado, jaExistia: true };

  db.prepare(`INSERT INTO setor_ramais (setor_id, ramal_curto, ocorrencias, linha_origem) VALUES (?, ?, 1, NULL)`)
    .run(id, curto);

  const nomeSetor = db.prepare(`SELECT setor FROM setores WHERE id = ?`).get(id)?.setor || id;
  const scanId = db.prepare(`SELECT IFNULL(MAX(id), 0) m FROM scans`).get().m;
  db.prepare(`INSERT INTO events (scan_id, ip, event, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(scanId, dev.ip, 'setor_vinculado', `ramal ${dev.ramal || curto} -> ${nomeSetor} [${fonte}]`, new Date().toISOString());

  return { ok: true, setorId: id, criado, jaExistia: false };
}

/** Remove o vinculo de um ramal com um setor. */
export function desvincularSetor(db, { ramal, setorId }) {
  const curto = ramalCurto(ramal);
  const sid = Number(setorId);
  if (!curto || !sid) return { ok: false, erro: 'ramal ou setor invalido' };

  const dev = db.prepare(`SELECT ip, ramal FROM devices WHERE substr(ramal, 3) = ?`).get(curto);
  const s = db.prepare(`SELECT setor FROM setores WHERE id = ?`).get(sid);

  const r = db.prepare(`DELETE FROM setor_ramais WHERE setor_id = ? AND ramal_curto = ?`).run(sid, curto);
  if (!Number(r.changes)) return { ok: false, erro: 'vinculo nao encontrado' };

  const scanId = db.prepare(`SELECT IFNULL(MAX(id), 0) m FROM scans`).get().m;
  db.prepare(`INSERT INTO events (scan_id, ip, event, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(scanId, dev?.ip || '*', 'setor_desvinculado',
      `ramal ${dev?.ramal || curto} removido de ${s?.setor || sid}`, new Date().toISOString());

  return { ok: true };
}

/**
 * Edita os dados de um setor existente (nome, andar, predio, ala).
 * O id nao muda, entao todos os vinculos existentes continuam valendo.
 */
export function editarSetor(db, { setorId, setor, andar, predio, ala }) {
  const id = Number(setorId);
  if (!id) return { ok: false, erro: 'setor invalido' };

  const atual = db.prepare(`SELECT * FROM setores WHERE id = ?`).get(id);
  if (!atual) return { ok: false, erro: 'setor nao encontrado' };

  const nome = String(setor ?? atual.setor).trim();
  if (!nome) return { ok: false, erro: 'o nome do setor nao pode ficar vazio' };

  const and = String(andar ?? atual.andar ?? '').trim() || null;
  const pred = String(predio ?? atual.predio ?? '').trim() || null;
  const al = String(ala ?? atual.ala ?? '').trim() || null;

  // impede criar duplicata (outro setor com mesmo nome e andar)
  const dup = db.prepare(
    `SELECT id FROM setores WHERE setor = ? AND IFNULL(andar,'') = IFNULL(?,'') AND id <> ? LIMIT 1`,
  ).get(nome, and, id);
  if (dup) {
    return { ok: false, erro: `ja existe outro setor chamado "${nome}" com este andar (id ${dup.id})` };
  }

  const semMudanca = nome === atual.setor && and === atual.andar && pred === atual.predio && al === atual.ala;
  if (semMudanca) return { ok: true, semMudanca: true };

  db.prepare(`UPDATE setores SET setor = ?, andar = ?, predio = ?, ala = ? WHERE id = ?`)
    .run(nome, and, pred, al, id);

  const scanId = db.prepare(`SELECT IFNULL(MAX(id), 0) m FROM scans`).get().m;
  const antes = `${atual.setor}${atual.andar ? ' [' + atual.andar + ']' : ''}`;
  const depois = `${nome}${and ? ' [' + and + ']' : ''}`;
  db.prepare(`INSERT INTO events (scan_id, ip, event, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(scanId, '*', 'setor_editado', `${antes} -> ${depois}`, new Date().toISOString());

  return { ok: true, semMudanca: false };
}
