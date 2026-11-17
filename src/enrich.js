/**
 * Enriquecimento de identidade: ramal, modelo, firmware e serial via SIP OPTIONS TCP.
 * Tambem usado como ciclo de monitoramento (online/offline + mudanca de ramal).
 */
import { identifyViaSip, parseSipIdentity, sipOptionsTcpRaw } from './lib/sipid.js';
import { pMap } from './lib/pool.js';
import { expandTargets, DEFAULT_TARGETS } from './config.js';
import {
  openDb, updateSipIdentity, setPresence, logEvent, registerNewDevice,
  startMonitorRun, finishMonitorRun, insertSample, inventoryRows, createScan, pruneSamples,
  knownTargets, maybeVacuum, refreshStats, devicesParaMonitor,
} from './lib/db.js';

const MONITOR_SCOPE = 'monitor';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

/**
 * Consulta o SIP de cada telefone e grava ramal/modelo/firmware/serial.
 * @param {{ dbPath?: string, concurrency?: number, monitor?: boolean, timeoutMs?: number, verbose?: boolean }} opts
 */
export async function enrichPhones({
  dbPath = 'voip.sqlite',
  concurrency = 8,
  monitor = false,
  timeoutMs = 4000,
  targets = null, // null = usa os ranges de scans anteriores, ou DEFAULT_TARGETS
  sweepTimeoutMs = 500,
  sweepConcurrency = 128,
  verbose = true,
} = {}) {
  const log = verbose ? (...a) => console.log(...a) : () => {};
  const db = openDb(dbPath);
  const rows = devicesParaMonitor(db);
  const t0 = Date.now();

  // escopo da varredura: argumento > ranges de scans anteriores > padrao
  const scope = targets || knownTargets(db);
  const monitorTargets = scope.length ? scope : DEFAULT_TARGETS;

  if (monitor) {
    const runId = startMonitorRun(db);
    const scanId = createScan(db, { targets: monitorTargets, options: { monitor: true } });
    const known = new Map(rows.map((r) => [r.ip, r]));

    // 1) varre TODO o range (nao so os IPs conhecidos)
    const allIps = expandTargets(monitorTargets);
    let done = 0;
    const found = new Map(); // ip -> identidade SIP (apenas quem respondeu)
    await pMap(allIps, async (ip) => {
      const raw = await sipOptionsTcpRaw(ip, { timeoutMs: sweepTimeoutMs });
      const id = parseSipIdentity(raw);
      if (id.status === 200) found.set(ip, id);
      done++;
      if (verbose && done % 32 === 0) {
        process.stdout.write(`\r  varrendo ${String(done).padStart(3)}/${allIps.length}  |  ${found.size} aparelhos encontrados   `);
      }
    }, sweepConcurrency);
    if (verbose) process.stdout.write('\n');

    // 2) novos aparelhos que apareceram no range
    const novos = [];
    for (const [ip, id] of found) {
      if (!known.has(ip)) {
        registerNewDevice(db, scanId, ip, id);
        novos.push({ ip, ramal: id.ramal, model: id.model, firmware: id.firmware });
      }
    }

    // 3) quem sumiu: conhecidos que nao responderam nesta varredura
    const desaparecidos = [];
    let online = 0;
    let withRamal = 0;
    const changed = [];

    for (const r of rows) {
      const id = found.get(r.ip);
      const isOnline = !!id;
      const presence = setPresence(db, r.ip, isOnline);
      if (isOnline) {
        online++;
        const { ramalChanged, previous } = updateSipIdentity(db, r.ip, id);
        if (ramalChanged) {
          changed.push({ ip: r.ip, from: previous, to: id.ramal });
          logEvent(db, scanId, r.ip, 'ramal_changed', `${previous} -> ${id.ramal}`);
        }
        if (id.ramal) withRamal++;
      } else {
        if (presence.changed) logEvent(db, scanId, r.ip, 'disappeared', `ramal ${r.ramal || '?'} nao respondeu`);
        desaparecidos.push({ ip: r.ip, ramal: r.ramal, mac: r.mac, last_seen: r.last_seen });
      }
      insertSample(db, runId, r.ip, isOnline, id?.ramal ?? null, id?.firmware ?? null);
    }

    finishMonitorRun(db, runId, {
      checked: allIps.length, online, offline: rows.length - online, withRamal,
    });
    // retencao: 30 dias (com coleta de 15 min isso e ~680 mil linhas)
    const pruned = pruneSamples(db, 30);
    if (pruned) log(`  (${pruned} amostras antigas removidas — retencao de 30 dias)`);
    if (maybeVacuum(db)) log('  (banco compactado: VACUUM)');

    // recalcula o cache materializado (uma vez por ciclo, atomico).
    // A interface passa a ler tabelas de 250 linhas em vez de agregar 100k+.
    const st = refreshStats(db);
    log(`  Cache de estatisticas: ${st.devices} dispositivos, ${st.episodios} episodios em ${st.ms} ms`);

    log(`\n${c.bold('== Monitoramento (varredura ampla) ==')}`);
    log(`  IPs varridos:   ${allIps.length} (${monitorTargets.join(', ')})`);
    log(`  Aparelhos:      ${found.size} responderam`);
    log(`  Online:         ${c.green(String(online))}  |  Desaparecidos: ${c.red(String(desaparecidos.length))}`);
    if (novos.length) {
      log(`\n  ${c.yellow('NOVOS aparelhos no range:')}`);
      for (const n of novos) log(`    ${n.ip.padEnd(15)} ramal ${n.ramal || '?'}  ${n.model || ''} ${n.firmware || ''}`);
    }
    if (desaparecidos.length) {
      log(`\n  ${c.red('DESAPARECIDOS (nao responderam):')}`);
      for (const d of desaparecidos) log(`    ${d.ip.padEnd(15)} ramal ${d.ramal || '?'}  visto em ${d.last_seen}`);
    }
    if (changed.length) {
      log(`\n  ${c.yellow('Ramais alterados:')}`);
      for (const ch of changed) log(`    ${ch.ip.padEnd(15)} ${ch.from} -> ${ch.to}`);
    }
    log(`\n  Duracao: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    db.close();
    return {
      total: rows.length, scanned: allIps.length, found: found.size,
      online, offline: rows.length - online, withRamal,
      novos, desaparecidos, changed,
    };
  }

  // enriquecimento unico
  let withRamal = 0;
  let done = 0;
  const failures = [];
  const alvo = rows.length ? rows : [];
  await pMap(alvo, async (r) => {
    const id = await identifyViaSip(r.ip, { timeoutMs });
    if (id.status === 200) {
      updateSipIdentity(db, r.ip, id);
      if (id.ramal) withRamal++;
    } else {
      failures.push(r.ip);
    }
    done++;
    if (verbose) process.stdout.write(`\r  ${done}/${rows.length}  ${r.ip.padEnd(15)} ramal=${id.ramal || '-'} fw=${id.firmware || '-'}   `);
  }, concurrency);
  if (verbose) process.stdout.write('\n');

  log(`\n${c.bold('== Identidade SIP ==')}`);
  log(`  Telefones: ${rows.length}  |  com ramal: ${c.green(String(withRamal))}  |  sem resposta: ${failures.length}`);
  if (failures.length) log(`  Sem resposta: ${failures.join(', ')}`);
  db.close();
  return { total: rows.length, withRamal, failures };
}

/** Lista ramal -> ip para conferir rapido. */
export function printRamais(dbPath = 'voip.sqlite') {
  const db = openDb(dbPath);
  for (const r of devicesParaMonitor(db)) {
    console.log(`${String(r.ramal || '-').padEnd(8)} ${r.ip.padEnd(15)} ${(r.model || '-').padEnd(16)} ${r.firmware || '-'}`);
  }
  db.close();
}
