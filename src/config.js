/**
 * Configuração central do scanner.
 */

/**
 * Portas TCP relevantes para identificação de telefones VoIP / aparelhos SIP.
 * source: heurísticas de mercado (Yealink, Grandstream, Cisco, Snom, Polycom, Aastra/Mitel, Fanvil, Avaya).
 */
export const TCP_PORTS = [
  { port: 80, name: 'http' },
  { port: 443, name: 'https' },
  { port: 22, name: 'ssh' },
  { port: 23, name: 'telnet' },
  { port: 5060, name: 'sip-tcp' },
  { port: 5061, name: 'sip-tls' },
  { port: 8080, name: 'http-alt' },
  { port: 8443, name: 'https-alt' },
  { port: 8000, name: 'http-8000' },
  { port: 389, name: 'ldap' },
  { port: 636, name: 'ldaps' },
  { port: 161, name: 'snmp' },
  // Portas HTTP alternativas usadas por algumas marcas
  { port: 8060, name: 'http-8060' },
  { port: 3702, name: 'ws-discovery' },
  { port: 1711, name: 'avaya-http' },
  { port: 8483, name: 'polycom-https' },
].map((p) => ({ ...p, proto: 'tcp' }));

/**
 * Portas UDP típicas de VoIP. UDP varredura é feita por envio de payload
 * e leitura de resposta (SIP OPTIONS) — não é possível "connect".
 */
export const UDP_PORTS = [
  { port: 5060, name: 'sip-udp' },
  { port: 5061, name: 'sip-tls' },
  { port: 5062, name: 'sip-udp-5062' },
  { port: 5063, name: 'sip-udp-5063' },
  { port: 5064, name: 'sip-udp-5064' },
  { port: 5065, name: 'sip-udp-5065' },
  { port: 3478, name: 'stun' },
  { port: 3479, name: 'stun-alt' },
  { port: 161, name: 'snmp' },
].map((p) => ({ ...p, proto: 'udp' }));

/**
 * Alvos padrao. Ajuste para a sua rede, ou passe --targets na linha de comando.
 * Ex.: export const DEFAULT_TARGETS = ['10.20.30.0/24', '10.20.31.0/24'];
 */
export const DEFAULT_TARGETS = ['10.0.0.0/24'];

/**
 * Faixas onde os telefones IP do hospital podem estar.
 *
 * `172.18.90.0/24` e `172.18.91.0/24` sao as faixas de VoIP previstas.
 * `192.168.61.0/24` entrou porque aparelhos migraram para fora do padrao
 * (caso do ramal 402153, que apareceu em 192.168.61.73). Enquanto a empresa
 * de VoIP nao traz esses aparelhos de volta, a faixa precisa ser varrida —
 * senao qualquer telefone que caia la vira falso "offline", mesmo tocando
 * normalmente.
 *
 * O que NAO estiver aqui nao e varrido: um aparelho que mudar para outra
 * faixa volta a desaparecer do inventario.
 */
export const MONITOR_TARGETS = ['172.18.90.0/24', '172.18.91.0/24', '192.168.61.0/24'];

export const DEFAULTS = {
  /** Timeout do ICMP / conectividade inicial (ms). */
  pingTimeoutMs: 1000,
  /** Timeout por tentativa TCP connect (ms). */
  tcpTimeoutMs: 800,
  /** Timeout de resposta UDP SIP (ms). */
  udpTimeoutMs: 1200,
  /** Concorrência em host sweep (hosts simultâneos). */
  hostConcurrency: 64,
  /** Concorrência em port scan (sockets simultâneos por host). */
  portConcurrency: 32,
  /** Porta base para SNMP (usada apenas se solicitado). */
  dbPath: 'voip.sqlite',
  /** Retentar portas TCP fechadas por reset imediato? */
  retryPorts: 1,
};

/** Fontes de identificação (fingerprints) por User-Agent / Server. */
export const VENDOR_FINGERPRINTS = [
  { match: /yealink/i, vendor: 'Yealink', type: 'phone' },
  { match: /grandstream|gxp|c[a-z]?p2|gxv/i, vendor: 'Grandstream', type: 'phone' },
  { match: /snom/i, vendor: 'Snom', type: 'phone' },
  { match: /polycom|polycomsoundpoint|vvx/i, vendor: 'Polycom', type: 'phone' },
  { match: /aastra|mitel/i, vendor: 'Mitel/Aastra', type: 'phone' },
  { match: /fanvil/i, vendor: 'Fanvil', type: 'phone' },
  { match: /cisco|spa\d|cp-\d|ata\d|ucs/i, vendor: 'Cisco', type: 'phone' },
  { match: /avaya|j100|96\d\d|16\d\d/i, vendor: 'Avaya', type: 'phone' },
  { match: /panasonic|kx-?[th]|nt\d{3}/i, vendor: 'Panasonic', type: 'phone' },
  { match: /nec|univerge|dt\d{3}/i, vendor: 'NEC', type: 'phone' },
  { match: /unify|openscape|siemens|optipoint/i, vendor: 'Unify', type: 'phone' },
  { match: /3cx/i, vendor: '3CX', type: 'pbx' },
  { match: /asterisk|freepbx|chan_sip/i, vendor: 'Asterisk', type: 'pbx' },
  { match: /freeSwitch|FreeSWITCH|freeswitch/i, vendor: 'FreeSWITCH', type: 'pbx' },
  { match: /speech|linux|ubuntu/i, vendor: 'Linux-based', type: 'phone' },
];

/**
 * Heurística de classificação de host, a partir das portas abertas.
 * Retorna { type, confidence, reasons[] }.
 */
export function classifyHost(openPorts) {
  const ports = new Set(openPorts.map((p) => p.port));
  const reasons = [];
  let type = 'unknown';
  let confidence = 0;

  const hasSip = ports.has(5060) || ports.has(5061) || ports.has(5062);
  const hasHttp = ports.has(80) || ports.has(8080) || ports.has(443) || ports.has(8443);

  if (hasSip) {
    reasons.push('porta SIP aberta');
    confidence += 60;
    type = 'phone';
  }
  if (hasHttp) {
    reasons.push('interface web');
    confidence += 10;
  }
  if (ports.has(161)) {
    reasons.push('SNMP disponível');
    confidence += 5;
  }
  if (ports.has(22)) {
    reasons.push('SSH aberto');
    confidence += 5;
  }
  if (ports.size === 0) {
    type = 'dead';
    confidence = 100;
    reasons.push('nenhuma porta aberta (host não respondeu)');
  } else if (!hasSip && !hasHttp) {
    type = 'other';
    confidence = 30;
    reasons.push('nenhuma porta típica de VoIP');
  }

  return { type, confidence: Math.min(confidence, 100), reasons };
}

/** Normaliza CIDR "a/b" ou "a-b" em lista de endereços. */
export function expandTargets(targets) {
  const out = [];
  for (const raw of targets) {
    const t = String(raw).trim();
    if (!t) continue;
    if (t.includes('/')) {
      out.push(...expandCidr(t));
    } else if (t.includes('-')) {
      out.push(...expandRange(t));
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(t)) {
      out.push(t);
    } else {
      throw new Error(`Target inválido: ${raw}`);
    }
  }
  // remove duplicados preservando ordem
  return [...new Set(out)];
}

function expandCidr(cidr) {
  const [ip, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!(bits >= 0 && bits <= 32)) throw new Error(`Máscara inválida: ${cidr}`);
  const parts = ip.split('.').map(Number);
  if (parts.some((p) => !(p >= 0 && p <= 255))) throw new Error(`IP inválido: ${cidr}`);

  const ipInt = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  const out = [];
  for (let i = network; i <= broadcast; i++) {
    out.push(intToIp(i));
    if (out.length > 65536) throw new Error(`Range muito grande (>65536 hosts): ${cidr}`);
  }
  return out;
}

function expandRange(range) {
  // suporta "10.0.0.1-254" e "10.0.0.1-10.0.0.254"
  const [startStr, endStr] = range.split('-').map((s) => s.trim());
  const startParts = startStr.split('.').map(Number);
  let endIp;
  if (endStr.includes('.')) {
    endIp = endStr;
  } else {
    endIp = `${startParts[0]}.${startParts[1]}.${startParts[2]}.${endStr}`;
  }
  const start = ipToInt(startStr);
  const end = ipToInt(endIp);
  if (end < start) throw new Error(`Range inválido: ${range}`);
  if (end - start > 65536) throw new Error(`Range muito grande: ${range}`);
  const out = [];
  for (let i = start; i <= end; i++) out.push(intToIp(i));
  return out;
}

export function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) throw new Error(`IP inválido: ${ip}`);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
