/**
 * Probes SIP (UDP/TCP) para identificar telefones e PBX.
 * - SIP OPTIONS (ping) → resposta com Server/User-Agent
 * - Detecção de métodos via OPTIONS
 */
import dgram from 'node:dgram';
import net from 'node:net';
import crypto from 'node:crypto';
import { VENDOR_FINGERPRINTS } from '../config.js';

function sipMessage(method, target, extraHeaders = '') {
  const branch = `z9hG4bK-${crypto.randomBytes(6).toString('hex')}`;
  const tag = crypto.randomBytes(6).toString('hex');
  return [
    `${method} sip:${target} SIP/2.0`,
    `Via: SIP/2.0/UDP 0.0.0.0:5060;branch=${branch}`,
    `Max-Forwards: 70`,
    `To: <sip:${target}>;tag=${tag}`,
    `From: <sip:scanner@0.0.0.0>;tag=${tag}`,
    `Call-ID: ${crypto.randomBytes(8).toString('hex')}@scanner`,
    `CSeq: 1 ${method}`,
    'Contact: <sip:scanner@0.0.0.0:5060>',
    'User-Agent: voip-scanner/1.0',
    'Accept: application/sdp',
    extraHeaders,
    `Content-Length: 0`,
    '',
    '',
  ].join('\r\n');
}

/** Envia SIP OPTIONS via UDP e lê resposta. */
export function sipOptionsUdp(host, port = 5060, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const result = { ok: false, data: null, target: `${host}:${port}`, proto: 'udp', raw: null, error: null };
    let settled = false;
    const sock = dgram.createSocket('udp4');
    const finish = (err) => {
      if (settled) return;
      settled = true;
      result.error = err || null;
      try { sock.close(); } catch {}
      resolve(result);
    };
    const msg = Buffer.from(sipMessage('OPTIONS', `${host}:${port}`), 'utf8');
    sock.on('message', (data) => {
      result.ok = true;
      result.raw = data.toString('utf8');
      result.data = parseSip(result.raw);
      finish();
    });
    sock.on('error', (err) => finish(err.code || err.message));
    sock.send(msg, port, host, (err) => {
      if (err) finish(err.code || err.message);
    });
    setTimeout(() => finish('timeout'), timeoutMs).unref?.();
  });
}

/** Envia SIP OPTIONS via TCP. */
export function sipOptionsTcp(host, port = 5060, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const result = { ok: false, data: null, target: `${host}:${port}`, proto: 'tcp', raw: null, error: null };
    let settled = false;
    let buf = '';
    const finish = (err) => {
      if (settled) return;
      settled = true;
      result.error = err || null;
      try { sock.destroy(); } catch {}
      resolve(result);
    };
    const sock = net.connect({ host, port }, () => {
      try { sock.write(sipMessage('OPTIONS', `${host}:${port}`)); } catch (e) { finish(e.message); }
    });
    sock.setTimeout(timeoutMs);
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (/^SIP\/2\.0\s+\d{3}/m.test(buf)) {
        result.ok = true;
        result.raw = buf;
        result.data = parseSip(buf);
        finish();
      }
    });
    sock.on('end', () => finish());
    sock.on('timeout', () => finish('timeout'));
    sock.on('error', (e) => finish(e.code || e.message));
  });
}

function parseSip(raw) {
  const out = {
    status: null,
    server: null,
    userAgent: null,
    allow: null,
    allowEvents: null,
    methods: null,
    vendor: null,
  };
  try {
    if (!raw) return out;
    const first = raw.split('\r\n')[0] || '';
    const sm = first.match(/^SIP\/2\.0\s+(\d{3})\s+(.*)$/i);
    if (sm) { out.status = Number(sm[1]); out.reason = sm[2]; }
    const field = (name) => {
      const re = new RegExp(`^${name}:\\s*(.+)$`, 'mi');
      const m = raw.match(re);
      return m ? m[1].trim() : null;
    };
    out.server = field('Server');
    out.userAgent = field('User-Agent');
    out.allow = field('Allow');
    if (out.allow) out.methods = out.allow.split(',').map((s) => s.trim()).filter(Boolean);
    out.allowEvents = field('Allow-Events');

    const idText = `${out.server || ''} ${out.userAgent || ''}`;
    for (const f of VENDOR_FINGERPRINTS) {
      if (f.match.test(idText)) { out.vendor = f.vendor; out.vendorType = f.type; break; }
    }
  } catch {
    // ignora
  }
  return out;
}

/** Prova SIP em um host: UDP 5060 + opcional TCP 5060. */
export async function probeSip(host, { udp = true, tcp = false, timeoutMs = 1200 } = {}) {
  const probes = [];
  if (udp) probes.push(sipOptionsUdp(host, 5060, timeoutMs));
  if (tcp) probes.push(sipOptionsTcp(host, 5060, timeoutMs));
  const results = await Promise.all(probes);
  return results;
}
