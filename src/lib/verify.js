/**
 * Verificação de "host real" x "resposta de firewall".
 *
 * PROBLEMA REAL ENCONTRADO NESTA REDE:
 * Um firewall/IPS corporativo responde o handshake TCP (SYN-ACK) em nome de
 * QUALQUER IP do range, inclusive IPs inexistentes e de outras sub-redes
 * (testado: IPs de redes nao usadas e enderecos de broadcast respondiam em ~1ms).
 * Portanto "connect OK" NÃO significa host real. Um scan clássico de TCP
 * connect reportou 509/512 "hosts vivos" — 100% falso positivo.
 *
 * SOLUÇÃO (critérios de host real):
 *   1. O host precisa PRODUZIR BITS: completar um handshake TLS (certificado
 *      de peer) ou responder HTTP com headers. Firewall só faz o SYN-ACK e
 *      depois fica mudo.
 *   2. Confirmar com o certificado: aparelhos ALE (Alcatel-Lucent Enterprise)
 *      usam cert autoassinado com subject O=Aledevice, OU=PKI Authority,
 *      CN=<MAC em 12 hex sem separador> e issuer O=ALE.
 *
 * O MAC extraído do certificado é a identidade mais confiável do aparelho.
 */
import tls from 'node:tls';
import net from 'node:net';

/** Extrai o certificado do peer via TLS. */
export function getPeerCert(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const out = { ok: false, cert: null, proto: null, error: null, ms: 0 };
    const t0 = Date.now();
    let settled = false;
    let sock;
    const finish = () => {
      if (settled) return;
      settled = true;
      out.ms = Date.now() - t0;
      try { sock?.destroy(); } catch {}
      resolve(out);
    };
    try {
      sock = tls.connect({ host, port, rejectUnauthorized: false, timeout: timeoutMs });
    } catch (e) {
      out.error = e.message;
      return resolve(out);
    }
    sock.on('secureConnect', () => {
      try {
        const c = sock.getPeerCertificate();
        if (c && c.subject) {
          out.ok = true;
          out.proto = sock.getProtocol();
          out.cert = {
            subject: c.subject,
            issuer: c.issuer,
            san: c.subjectaltname || null,
            validTo: c.valid_to,
            fingerprint256: c.fingerprint256 || null,
            serialNumber: c.serialNumber || null,
          };
        }
      } catch (e) {
        out.error = e.message;
      }
      finish();
    });
    sock.on('timeout', () => { out.error = 'timeout'; finish(); });
    sock.on('error', (e) => { out.error = e.code || e.message; finish(); });
    sock.once('close', () => finish());
    setTimeout(finish, timeoutMs + 500).unref?.();
  });
}

/** Normaliza um MAC "3C28A6126D92" ou "3c:28:a6:12:6d:92" para "3c:28:a6:12:6d:92". */
export function normalizeMac(raw) {
  if (!raw) return null;
  const hex = String(raw).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':').toLowerCase();
}

/**
 * Interpreta o certificado e retorna fingerprint do fornecedor/modelo.
 * Retorna { vendor, model, deviceType, mac, evidence[] }
 */
export function fingerprintCert(cert) {
  const r = { vendor: null, model: null, deviceType: null, mac: null, evidence: [] };
  if (!cert) return r;
  const subj = cert.subject || {};
  const iss = cert.issuer || {};
  const o = subj.O || '';
  const issuerO = iss.O || '';
  const cn = subj.CN || '';

  // Alcatel-Lucent Enterprise (ALE) — telefones IP (issuer "Aledevice Wired Phones")
  if (/aledevice/i.test(o) || /^ALE$/i.test(issuerO) || /alcatel/i.test(issuerO) || /alcatel/i.test(o)) {
    r.vendor = 'Alcatel-Lucent Enterprise';
    r.deviceType = 'phone';
    const issuerCN = iss.CN || '';
    if (/wired phones/i.test(issuerCN)) r.model = 'ALE Aledevice Wired Phones';
    else if (/wireless/i.test(issuerCN)) r.model = 'ALE Aledevice Wireless Phones';
    else if (issuerCN) r.model = `ALE ${issuerCN}`;
    else r.model = 'ALE IP device';
    const mac = normalizeMac(cn);
    if (mac) {
      r.mac = mac;
      r.evidence.push(`cert CN=${cn} (MAC do aparelho)`);
    }
    r.evidence.push(`issuer O=${issuerO || o}${issuerCN ? ` CN=${issuerCN}` : ''}`);
    if (/ALCICT/i.test(cert.san || '')) r.evidence.push('SAN UPN=ALCICT');
  } else if (cn) {
    r.evidence.push(`CN=${cn}`);
  }
  if (r.evidence.length) r.evidence.push('certificado 2042 = cert de fabrica');
  return r;
}

/**
 * Verificação completa de um IP:
 *  - tenta TLS nas portas web/TLS conhecidas
 *  - tenta HTTP simples (GET / HTTP/1.0) para pegar Server header
 *  - classifica: real / firewall-stub / dead
 */
export async function verifyHost(ip, { tlsPorts = [443, 5061, 8443], httpPorts = [80, 8080], timeoutMs = 2500 } = {}) {
  const result = {
    ip,
    real: false,
    kind: 'unknown', // 'ale-phone' | 'http-host' | 'tls-host' | 'firewall-stub' | 'dead'
    mac: null,
    vendor: null,
    model: null,
    deviceType: null,
    tls: null,
    http: null,
    evidence: [],
  };

  // 1) TLS — melhor prova de host real + identidade
  for (const port of tlsPorts) {
    const t = await getPeerCert(ip, port, timeoutMs);
    if (t.ok) {
      result.real = true;
      result.tls = { port, ...t.cert, protocol: t.proto };
      const fp = fingerprintCert(t.cert);
      result.evidence.push(`TLS ${port}: handshake completo (${t.proto})`);
      result.evidence.push(...fp.evidence);
      if (fp.vendor) result.vendor = fp.vendor;
      if (fp.model) result.model = fp.model;
      if (fp.deviceType) result.deviceType = fp.deviceType;
      if (fp.mac) result.mac = fp.mac;
      result.kind = fp.deviceType === 'phone' ? 'ale-phone' : 'tls-host';
      break;
    }
  }

  // 3) reverso de DNS (evidência auxiliar, não prova)
  // (feito no scan para não pesar aqui)

  // 2) HTTP — segunda prova de host real
  for (const port of httpPorts) {
    const h = await httpProbe(ip, port, timeoutMs);
    if (h.ok) {
      result.real = true;
      result.http = { port, ...h };
      result.evidence.push(`HTTP ${port}: ${h.statusLine} (Server: ${h.server || 'n/a'})`);
      if (!result.vendor && h.server) result.vendor = null; // lighttpd genérico
      if (result.kind === 'unknown') result.kind = 'http-host';
      if (!result.deviceType && /301/.test(String(h.status || ''))) result.deviceType = 'device';
      break;
    }
  }

  if (!result.real) {
    result.kind = 'firewall-stub';
    result.evidence.push('TCP connect aceito mas host nao produziu bytes (resposta de firewall/NAT)');
  } else if (result.deviceType === 'phone' && !result.mac) {
    result.mac = null;
  }

  return result;
}

/** Requisição HTTP mínima; considera "ok" apenas se veio uma linha de status real. */
export function httpProbe(host, port, timeoutMs = 2500, useTls = false) {
  return new Promise((resolve) => {
    const out = { ok: false, status: null, statusLine: null, server: null, title: null, location: null, headers: {}, error: null };
    let buf = '';
    let settled = false;
    let sock;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      out.error = err || null;
      parseHttp(buf, out);
      // só é host real se veio status line HTTP de verdade
      if (out.status) out.ok = true;
      try { sock?.destroy(); } catch {}
      resolve(out);
    };
    const req = () => {
      try {
        sock.write(`GET / HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: voip-scanner/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
      } catch (e) { finish(e.message); }
    };
    try {
      sock = useTls
        ? tls.connect({ host, port, rejectUnauthorized: false, timeout: timeoutMs }, req)
        : net.connect({ host, port }, req);
    } catch (e) {
      out.error = e.message;
      return resolve(out);
    }
    sock.setTimeout(timeoutMs);
    sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.length > 128 * 1024) finish(); });
    sock.on('end', () => finish());
    sock.on('timeout', () => finish('timeout'));
    sock.on('error', (e) => finish(e.code || e.message));
    setTimeout(() => finish('hard-timeout'), timeoutMs + 500).unref?.();
  });
}

function parseHttp(buf, out) {
  try {
    const first = buf.split('\r\n')[0] || '';
    const sm = first.match(/^HTTP\/\d\.\d\s+(\d{3})/i);
    if (sm) { out.status = Number(sm[1]); out.statusLine = first.trim(); }
    const serverM = buf.match(/^Server:\s*(.+)$/im);
    if (serverM) out.server = serverM[1].trim();
    const locM = buf.match(/^Location:\s*(.+)$/im);
    if (locM) out.location = locM[1].trim();
    for (const line of buf.split('\r\n')) {
      const hm = line.match(/^([A-Za-z-]+):\s*(.+)$/);
      if (hm) out.headers[hm[1].toLowerCase()] = hm[2].trim();
    }
    const tm = buf.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
    if (tm) out.title = tm[1].replace(/\s+/g, ' ').trim();
  } catch {
    // ignora
  }
}
