/**
 * Port scan TCP + coleta de banner HTTP/Server.
 */
import net from 'node:net';
import tls from 'node:tls';
import { pMap } from './pool.js';

/** Connect TCP simples com timeout. */
export function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ok, ms: Date.now() - start, error: error || null });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false, 'timeout'));
    sock.once('error', (e) => finish(false, e.code || e.message));
    sock.connect(port, host);
  });
}

function parseHttp(buf, result) {
  try {
    const statusLine = buf.split('\r\n')[0] || '';
    const sm = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/i);
    if (sm) result.status = Number(sm[1]);
    const serverM = buf.match(/^Server:\s*(.+)$/im);
    if (serverM) result.server = serverM[1].trim();
    for (const line of buf.split('\r\n')) {
      const hm = line.match(/^([A-Za-z-]+):\s*(.+)$/);
      if (hm) result.headers[hm[1].toLowerCase()] = hm[2].trim();
    }
    const tm = buf.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
    if (tm) result.title = tm[1].replace(/\s+/g, ' ').trim();
  } catch {
    // ignora
  }
}

/**
 * Pequena requisição HTTP(S) GET / para obter Server header e <title>.
 * Retorna { server, status, title, url, headers, error }.
 */
export function httpBanner(host, port, { timeoutMs = 1500, useTls = false } = {}) {
  return new Promise((resolve) => {
    const result = {
      server: null,
      status: null,
      title: null,
      url: `${useTls ? 'https' : 'http'}://${host}:${port}/`,
      headers: {},
      error: null,
    };
    let buf = '';
    let settled = false;
    let socket;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) result.error = err;
      parseHttp(buf, result);
      try { socket?.destroy(); } catch {}
      resolve(result);
    };

    if (useTls) {
      socket = tls.connect({ host, port, rejectUnauthorized: false, servername: undefined }, () => {
        try {
          socket.write(`GET / HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: voip-scanner/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
        } catch (e) { finish(e.message); }
      });
    } else {
      socket = net.connect({ host, port }, () => {
        try {
          socket.write(`GET / HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: voip-scanner/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
        } catch (e) { finish(e.message); }
      });
    }

    socket.setTimeout(timeoutMs);
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.length > 128 * 1024) finish();
    });
    socket.on('end', () => finish());
    socket.on('timeout', () => finish());
    socket.on('error', (e) => finish(e.code || e.message));
  });
}

/**
 * Varre as portas TCP configuradas em um host.
 */
export async function scanTcpPorts(ip, ports, { timeoutMs = 800, concurrency = 32 } = {}) {
  const res = await pMap(ports, async (p) => {
    const r = await tcpProbe(ip, p.port, timeoutMs);
    return r.ok ? { port: p.port, name: p.name, proto: 'tcp', ms: r.ms } : null;
  }, concurrency);
  return res.filter(Boolean);
}
