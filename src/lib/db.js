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
  `);
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

/** Remove amostras mais antigas que N dias (default 30). Mantem o banco pequeno. */
export function pruneSamples(db, days = 30) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const r = db.prepare(`DELETE FROM monitor_samples WHERE created_at < ?`).run(cutoff);
  db.prepare(`DELETE FROM monitor_runs WHERE finished_at IS NOT NULL AND finished_at < ?`).run(cutoff);
  return Number(r.changes);
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

/** Inventario para a interface web, ja com ramal. */
export function inventoryRows(db) {
  return db.prepare(
    `SELECT ip, mac, hostname, vendor, model, device_type, ramal, firmware, serial,
            sip_ua, http_server, ports_json, tls_json, first_seen, last_seen,
            online, missing_since
     FROM devices
     WHERE is_phone = 1
     ORDER BY CAST(ramal AS INTEGER) IS NULL, CAST(ramal AS INTEGER), ip`,
  ).all();
}
