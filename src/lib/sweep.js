/**
 * Host sweep: descobre hosts vivos por
 *  - TCP connect em portas comuns (mais confiável quando ICMP bloqueado)
 *  - UDP SIP OPTIONS (detecta telefones mesmo com 5060 aberto)
 *  - ARP/MAC table do Windows (enrichment)
 */
import net from 'node:net';
import { execFile } from 'node:child_process';
import { pMap } from './pool.js';
import { classifyHost, ipToInt } from '../config.js';

/** Dispara um connect TCP com timeout. Resolve {ok, ms, error}. */
export function tcpConnect(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ok, ms: Date.now() - start, error: error || null });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (err) => done(false, err.code || err.message));
    sock.connect(port, host);
  });
}

/** Faz bind TCP na porta (via listener efêmero) só para garantir que não usamos randoms colidindo. */
export function tcpListenOnce(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { srv.close(); } catch {}
      resolve({ ok, error: error || null });
    };
    srv.once('error', (e) => finish(false, e.code || e.message));
    srv.listen(port, host, () => finish(true));
    setTimeout(() => finish(false, 'timeout'), timeoutMs).unref?.();
  });
}

/**
 * Host sweep em lote.
 * Retorna Map<ip, { alive, openPorts:[{port,name,proto,ms}], mac, vendorHints }>
 */
export async function hostSweep(ips, opts = {}) {
  const {
    probeTcp = [{ port: 80, name: 'http' }, { port: 5060, name: 'sip' }, { port: 443, name: 'https' }, { port: 22, name: 'ssh' }, { port: 23, name: 'telnet' }],
    tcpTimeoutMs = 800,
    hostConcurrency = 64,
    onProgress = null,
  } = opts;

  const total = ips.length;
  let doneCount = 0;
  const results = new Map();

  await pMap(ips, async (ip) => {
    const opens = [];
    const attempts = await Promise.all(
      probeTcp.map(async (p) => {
        const r = await tcpConnect(ip, p.port, tcpTimeoutMs);
        return { port: p.port, name: p.name, proto: 'tcp', ok: r.ok, ms: r.ms, error: r.error };
      }),
    );
    for (const a of attempts) if (a.ok) opens.push({ port: a.port, name: a.name, proto: 'tcp', ms: a.ms });

    const alive = opens.length > 0;
    const cls = classifyHost(opens);
    results.set(ip, {
      ip,
      alive,
      openPorts: opens,
      classify: cls,
      mac: null,
      hostname: null,
    });
    doneCount++;
    if (onProgress) onProgress(doneCount, total);
  }, hostConcurrency);

  // Ordena por IP numericamente
  return new Map([...results.entries()].sort((a, b) => ipToInt(a[0]) - ipToInt(b[0])));
}

function execFileAsync(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, stdout) => {
      resolve({ err, stdout: stdout || '' });
    });
  });
}

/** Lê a tabela ARP (Windows: arp -a, Linux: ip neigh). */
export async function readArpTable() {
  const map = new Map();
  let out = '';
  if (process.platform === 'win32') {
    out = (await execFileAsync('arp', ['-a'])).stdout;
  } else {
    out = (await execFileAsync('ip', ['neigh'])).stdout;
  }
  const re = /(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    map.set(m[1], m[2].toLowerCase().replace(/:/g, '-'));
  }
  return map;
}

/** Resolve hostname reverso via DNS PTR (nslookup/dns.promises). */
export async function reverseDns(ip, timeoutMs = 600) {
  const dns = await import('node:dns/promises');
  try {
    const res = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    return res && res[0] ? res[0] : null;
  } catch {
    return null;
  }
}
