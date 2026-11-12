/**
 * Orquestrador da varredura (v2 — robusto a firewall/NAT que responde SYN).
 *
 * Nesta rede um firewall responde SYN-ACK para qualquer IP, então descoberta
 * por TCP connect puro gera 100% de falso positivo. A descoberta aqui exige
 * PROVA: handshake TLS completo (cert do peer) ou resposta HTTP com status.
 *
 * Fases:
 *   1. Descoberta: para cada IP, tentar TLS 443/5061 e HTTP 80/8080
 *   2. Fingerprint: certificado (ALE Aledevice → MAC), HTTP Server, SIP OPTIONS
 *   3. Confirmação de portas: só nos hosts já provados reais
 *   4. Persistência SQLite
 */
import {
  DEFAULT_TARGETS, DEFAULTS, expandTargets, VENDOR_FINGERPRINTS, TCP_PORTS,
} from './config.js';
import { pMap, fmtDuration } from './lib/pool.js';
import { verifyHost } from './lib/verify.js';
import { scanTcpPorts } from './lib/portscan.js';
import { probeSip } from './lib/sip.js';
import { readArpTable, reverseDns } from './lib/sweep.js';
import {
  openDb, createScan, finishScan, insertPorts, insertSipInfo, upsertDevice, logEvent,
} from './lib/db.js';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function bar(done, total) {
  const pct = total ? done / total : 0;
  const w = 30;
  const filled = Math.round(w * pct);
  return `${c.cyan('#'.repeat(filled))}${c.dim('-'.repeat(w - filled))} ${String(Math.round(pct * 100)).padStart(3)}% ${done}/${total}`;
}

export async function runScan({
  targets = DEFAULT_TARGETS,
  dbPath = DEFAULTS.dbPath,
  probeSipEnabled = true,
  confirmPorts = true,
  verbose = true,
  hostConcurrency = DEFAULTS.hostConcurrency,
  tcpTimeoutMs = DEFAULTS.tcpTimeoutMs,
  udpTimeoutMs = DEFAULTS.udpTimeoutMs,
  verifyTimeoutMs = 2500,
} = {}) {
  const t0 = Date.now();
  const ips = expandTargets(targets);
  const log = verbose ? (...a) => console.log(...a) : () => {};

  log(`\n${c.bold('== VoIP Scanner v2 ==')}`);
  log(`Alvos: ${targets.join(', ')} (${ips.length} enderecos)`);
  log(`Banco: ${dbPath}\n`);

  const db = openDb(dbPath);
  const scanId = createScan(db, { targets, options: { hostConcurrency, verifyTimeoutMs, probeSipEnabled, confirmPorts } });
  log(`Scan #${scanId} | ${new Date().toISOString()}`);

  // ---------- Fase 1: descoberta com prova ----------
  log(`\n${c.bold('[1/4] Descoberta com prova (TLS + HTTP)')}`);
  const verified = new Map();
  let done = 0;
  let lastDraw = 0;
  await pMap(ips, async (ip) => {
    const v = await verifyHost(ip, { timeoutMs: verifyTimeoutMs });
    verified.set(ip, v);
    done++;
    const now = Date.now();
    if (verbose && (now - lastDraw > 500 || done === ips.length)) {
      lastDraw = now;
      process.stdout.write(`\r  ${bar(done, ips.length)}   `);
    }
  }, hostConcurrency * 2);
  if (verbose) process.stdout.write('\n');

  const realHosts = [...verified.values()].filter((v) => v.real);
  const stubs = [...verified.values()].filter((v) => !v.real);
  log(`  Hosts reais (responderam TLS/HTTP): ${c.green(String(realHosts.length))}`);
  log(`  Sem resposta real (dead/stub):      ${c.dim(String(stubs.length))}`);

  // ---------- Fase 2: fingerprint complementar ----------
  log(`\n${c.bold('[2/4] Fingerprint complementar (SIP OPTIONS + HTTP details)')}`);
  const arp = await readArpTable().catch(() => new Map());
  done = 0;
  for (const v of realHosts) {
    if (probeSipEnabled) {
      const sip = await probeSip(v.ip, { udp: true, tcp: false, timeoutMs: udpTimeoutMs });
      v.sip = sip.find((r) => r.ok) || null;
      if (v.sip) {
        v.evidence.push(`SIP ${v.sip.proto}:${v.sip.data.status} Server=${v.sip.data.server || '-'} UA=${v.sip.data.userAgent || '-'}`);
        if (v.sip.data.vendor && !v.vendor) v.vendor = v.sip.data.vendor;
      }
    }
    v.hostname = await reverseDns(v.ip);
    if (!v.mac && arp.has(v.ip)) v.mac = arp.get(v.ip);
    done++;
    if (verbose) process.stdout.write(`\r  ${bar(done, realHosts.length)}   `);
  }
  if (verbose) process.stdout.write('\n');

  // ---------- Fase 3: portas confirmadas nos hosts reais ----------
  log(`\n${c.bold('[3/4] Portas confirmadas nos hosts reais')}`);
  done = 0;
  for (const v of realHosts) {
    if (confirmPorts) {
      v.openPorts = await scanTcpPorts(v.ip, TCP_PORTS, { timeoutMs: tcpTimeoutMs, concurrency: 16 });
    } else {
      v.openPorts = [];
    }
    // portas provadas pelos probes
    if (v.tls && !['443', '5061'].some(() => v.openPorts.some((p) => p.port === v.tls.port))) {
      if (!v.openPorts.some((p) => p.port === v.tls.port)) v.openPorts.push({ port: v.tls.port, name: 'tls', proto: 'tcp', ms: null });
    }
    if (v.http && !v.openPorts.some((p) => p.port === v.http.port)) v.openPorts.push({ port: v.http.port, name: 'http', proto: 'tcp', ms: null });
    if (v.sip && !v.openPorts.some((p) => p.port === 5060 && p.proto === v.sip.proto)) v.openPorts.push({ port: 5060, name: 'sip', proto: v.sip.proto, ms: null });
    v.openPorts.sort((a, b) => a.port - b.port);
    done++;
    if (verbose) process.stdout.write(`\r  ${bar(done, realHosts.length)}   `);
  }
  if (verbose) process.stdout.write('\n');

  // ---------- Fase 4: classificação + persistência ----------
  log(`\n${c.bold('[4/4] Classificacao e persistencia')}`);
  const devices = [];
  for (const v of realHosts) {
    const isPhone = v.deviceType === 'phone' || v.kind === 'ale-phone' || !!v.sip;
    const dev = {
      ip: v.ip,
      mac: v.mac,
      hostname: v.hostname || null,
      vendor: v.vendor,
      model: v.model,
      deviceType: v.deviceType || (v.sip ? 'phone' : 'device'),
      confidence: isPhone ? 95 : 60,
      sipServer: v.sip?.data?.server || null,
      sipUserAgent: v.sip?.data?.userAgent || null,
      sipMethods: v.sip?.data?.methods?.join(',') || null,
      httpServer: v.http?.server || null,
      httpTitle: v.http?.title || null,
      httpJson: v.http ? { port: v.http.port, status: v.http.status, location: v.http.location, server: v.http.server, title: v.http.title } : null,
      notes: v.evidence.join('; '),
      isPhone,
      openPorts: v.openPorts,
      tls: v.tls,
      evidence: v.evidence,
    };
    devices.push(dev);
    insertPorts(db, scanId, v.ip, v.openPorts);
    if (v.sip?.ok) insertSipInfo(db, scanId, v.ip, v.sip);
    const { isNew, added } = upsertDevice(db, scanId, dev);
    if (verbose && (isPhone || isNew)) {
      const tag = isNew ? c.green('NOVO') : (added.length ? c.yellow('+' + added.join(',')) : '');
      log(`  ${c.cyan('*')} ${v.ip.padEnd(15)} ${(v.vendor || '-').padEnd(28)} MAC=${(v.mac || '-').padEnd(17)} ${tag}`);
    }
  }

  // grava também uma linha-resumo dos stubs para auditoria
  const stubCount = stubs.length;
  if (stubCount) {
    logEvent(db, scanId, '*', 'firewall_stub_detected',
      `${stubCount} IPs aceitaram TCP mas nao produziram bytes (resposta de firewall/NAT)`);
  }

  const phones = devices.filter((d) => d.isPhone);
  finishScan(db, scanId, {
    state: 'done',
    hostsScanned: ips.length,
    hostsAlive: devices.length,
    phonesFound: phones.length,
  });

  const elapsed = (Date.now() - t0) / 1000;
  log(`\n${c.bold('== Resumo ==')}`);
  log(`  Scan #${scanId} | tempo: ${fmtDuration(elapsed)}`);
  log(`  Enderecos varridos: ${ips.length}`);
  log(`  Hosts reais:        ${devices.length}`);
  log(`  Telefones VoIP:     ${c.green(String(phones.length))}`);
  log(`  Firewall/NAT stubs: ${stubCount}`);
  printTable(phones, log);
  db.close();

  return { scanId, ips, devices, phones, stubs, elapsed };
}

export function trunc(s, n) {
  if (!s) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '...' : str;
}

export function printTable(rows, logFn = console.log) {
  if (!rows.length) return logFn('  (nenhum telefone encontrado)');
  const head = ['IP', 'MAC', 'VENDOR', 'MODELO', 'HTTP', 'PORTAS'];
  const data = rows.map((d) => [
    d.ip,
    d.mac || '-',
    d.vendor || '-',
    trunc(d.model || '-', 28),
    trunc(d.http_server || '-', 10),
    trunc(formatPorts(d), 28),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...data.map((r) => String(r[i]).length)));
  const line = (cells) => '  ' + cells.map((x, i) => String(x).padEnd(w[i])).join('  ');
  logFn(c.bold(line(head)));
  logFn('  ' + w.map((x) => '-'.repeat(x)).join('  '));
  for (const r of data) logFn(line(r));
}

/** Aceita registros do DB (ports_json) ou objetos vivos (openPorts). */
export function formatPorts(d) {
  if (Array.isArray(d.openPorts)) return d.openPorts.map((p) => p.port).join(',');
  if (typeof d.ports === 'string') return d.ports;
  if (typeof d.ports_json === 'string') {
    try {
      return JSON.parse(d.ports_json).map((x) => String(x).split('/')[0]).join(',');
    } catch {
      return '-';
    }
  }
  return '-';
}
