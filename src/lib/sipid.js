/**
 * Identificacao de ramal/modelo/firmware SEM login (SIP OPTIONS over TCP).
 *
 * Descoberta chave: estes telefones ALE respondem SIP OPTIONS (transporte TCP)
 * com "SIP/2.0 200 OK" mesmo de origem nao registrada. O header Contact desse
 * 200 OK carrega o AOR local do aparelho, que e o NUMERO DO RAMAL:
 *
 *   SIP/2.0 200 OK
 *   Contact: <sip:402025@10.0.0.2;transport=tls>        <-- ramal 402025
 *   User-Agent: ALE H3G 2.14.17.000.2515 3c28a6126d92   <-- modelo/fw/MAC
 *
 * Firmware novo acrescenta o serial no fim:
 *   User-Agent: ALE H3G 2.15.10.000.3000 3c28a6126a71 NET241001985
 *
 * Obs.: sobre UDP nao respondem; precisa ser TCP na 5060.
 */
import net from 'node:net';

/** Faz OPTIONS SIP/TCP e retorna a resposta 200 OK crua (ou null). */
export function sipOptionsTcpRaw(ip, { port = 5060, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    let sock;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sock?.destroy(); } catch {}
      resolve(buf || null);
    };
    try {
      sock = net.connect({ host: ip, port });
    } catch {
      return resolve(null);
    }
    sock.setTimeout(timeoutMs);
    const branch = 'z9hG4bK' + Math.random().toString(16).slice(2, 12);
    const callId = Math.random().toString(16).slice(2, 14) + '@voip-scanner';
    sock.on('connect', () => {
      try {
        sock.write(
          [
            `OPTIONS sip:${ip} SIP/2.0`,
            `Via: SIP/2.0/TCP ${ip}:5060;branch=${branch}`,
            'Max-Forwards: 70',
            `To: <sip:${ip}>`,
            `From: <sip:scanner@${ip}>;tag=${Date.now()}`,
            `Call-ID: ${callId}`,
            'CSeq: 1 OPTIONS',
            `Contact: <sip:scanner@${ip}:5060>`,
            'Content-Length: 0',
            '',
            '',
          ].join('\r\n'),
        );
      } catch {
        finish();
      }
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (/^SIP\/2\.0\s+(2\d\d|3\d\d|4\d\d|5\d\d)/m.test(buf)) setTimeout(finish, 250);
    });
    sock.on('timeout', finish);
    sock.on('error', finish);
    sock.on('close', finish);
    setTimeout(finish, timeoutMs + 500).unref?.();
  });
}

/**
 * Interpreta a resposta SIP.
 * Retorna { status, ramal, contact, model, firmware, mac, serial, allow, ua }.
 */
export function parseSipIdentity(raw) {
  const out = { status: null, ramal: null, contact: null, model: null, firmware: null, mac: null, serial: null, allow: null, ua: null };
  if (!raw) return out;
  const messages = raw.split(/(?=^SIP\/2\.0)/m).filter(Boolean);
  // usa o 200 OK (o 100 Trying nao traz Contact)
  const ok = messages.find((m) => /^SIP\/2\.0 200/m.test(m));
  if (!ok) {
    const any = messages[messages.length - 1];
    const sm = any?.match(/^SIP\/2\.0\s+(\d{3})/);
    if (sm) out.status = Number(sm[1]);
    return out;
  }
  const field = (name) => ok.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.trim() || null;
  out.status = 200;
  out.contact = field('Contact');
  out.allow = field('Allow');
  out.ua = field('User-Agent');

  // Contact: <sip:402025@10.0.0.2;transport=tls>  -> ramal
  if (out.contact) {
    const m = out.contact.match(/sips?:(?:[^@"<>]*@)?([^@;>?]+)@/i);
    if (m) out.ramal = m[1].trim();
    else {
      const only = out.contact.match(/sips?:([^;>@]+)/i);
      if (only) out.ramal = only[1].trim();
    }
  }

  // User-Agent: ALE <MODEL> <FIRMWARE> <MAC12> [SERIAL]
  if (out.ua) {
    const m = out.ua.match(/^ALE\s+(\S+)\s+(\S+)\s+([0-9a-f]{12})\s*(\S*)\s*$/i);
    if (m) {
      out.model = m[1];
      out.firmware = m[2];
      out.mac = m[3].match(/.{2}/g).join(':').toLowerCase();
      out.serial = m[4] || null;
    } else {
      const mac = out.ua.match(/\b([0-9a-f]{12})\b/i);
      if (mac) out.mac = mac[1].match(/.{2}/g).join(':').toLowerCase();
      const model = out.ua.match(/^ALE\s+(\S+)/i);
      if (model) out.model = model[1];
    }
  }
  return out;
}

/** Atalho: identifica um IP. */
export async function identifyViaSip(ip, opts) {
  return parseSipIdentity(await sipOptionsTcpRaw(ip, opts));
}
