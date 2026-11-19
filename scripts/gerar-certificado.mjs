/**
 * Gera o certificado de servidor para a maquina onde o projeto esta rodando.
 *
 * POR QUE DOIS NIVEIS (igual ao hmacn-acesso):
 * um certificado autoassinado com CA:TRUE e recusado pelo Firefox
 * (MOZILLA_PKIX_ERROR_CA_CERT_USED_AS_END_ENTITY), embora o Chrome aceite.
 * A estrutura correta e:
 *   1. uma CA local (ja existe em certs/ca.crt, instalada nas maquinas)
 *   2. um certificado de SERVIDOR assinado por ela
 *
 * A CA NAO muda: as maquinas que ja confiam nela continuam funcionando.
 * So o certificado de servidor e regerado quando muda o nome ou o IP.
 *
 * Uso:
 *   node scripts/gerar-certificado.mjs                    # detecta nome/IP da maquina
 *   node scripts/gerar-certificado.mjs --extra 10.1.2.3   # inclui outro IP/nome
 *   node scripts/gerar-certificado.mjs --todos            # mantem a lista atual e acrescenta
 *   node scripts/gerar-certificado.mjs --dias 825
 *   node scripts/gerar-certificado.mjs --nova-ca          # ATENCAO: exige reinstalar a CA
 *
 * Arquivos gerados em certs/:
 *   ca.crt        CA (instalar nas maquinas; ja versionada)
 *   ca.key        chave da CA — nunca sai daqui
 *   servidor.crt  certificado do servidor (usado pelo web-config.json)
 *   servidor.key  chave do servidor
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'certs');

const ORG = 'HMACN Alipio Correa Netto';
const CA_CN = 'HMACN Acesso - Autoridade Certificadora Local';
const DIAS_CA = 3650;
const DIAS_SERVIDOR = 825;

function arg(nome, padrao = null) {
  const i = process.argv.indexOf('--' + nome);
  if (i === -1) return padrao;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const DIAS = Number(arg('dias', DIAS_SERVIDOR));
const NOVA_CA = arg('nova-ca', false) === true;
const MANTER = arg('todos', false) === true;
const EXTRAS = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--extra' && process.argv[i + 1]) EXTRAS.push(process.argv[i + 1]);
}

function acharOpenssl() {
  const candidatos = [
    process.env.OPENSSL_PATH,
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'openssl',
  ].filter(Boolean);
  for (const c of candidatos) {
    const r = spawnSync(c, ['version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

/**
 * Descobre os nomes e IPs DESTA maquina.
 * E o que torna o projeto portavel: nada de lista fixa amarrada a um host.
 */
function detectarIdentidades() {
  const dns = [];
  const ips = [];

  const host = os.hostname();
  if (host) {
    dns.push(host.toLowerCase());
    // sufixo de dominio, quando houver
    const curto = host.split('.')[0];
    if (curto !== host) dns.push(curto.toLowerCase());
    const dominio = path.basename(os.userInfo().homedir) ? null : null;
    void dominio;
  }
  // forma FQDN pelo DNS do proprio host
  try {
    const fq = spawnSync('nslookup', [os.hostname()], { encoding: 'utf8', timeout: 4000 });
    const m = String(fq.stdout || '').match(/Name:\s+([\w.-]+)/i);
    if (m) dns.push(m[1].toLowerCase());
  } catch { /* sem nslookup: segue com o hostname */ }

  dns.push('localhost');
  ips.push('127.0.0.1');

  for (const lista of Object.values(os.networkInterfaces())) {
    for (const i of lista || []) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  }

  return { dns: [...new Set(dns)], ips: [...new Set(ips)] };
}

const openssl = acharOpenssl();
if (!openssl) {
  console.error('ERRO: openssl nao encontrado. Instale o Git for Windows ou defina OPENSSL_PATH.');
  process.exit(1);
}

fs.mkdirSync(DIR, { recursive: true });

function rodar(args, rotulo) {
  const r = spawnSync(openssl, args, { encoding: 'utf8', cwd: DIR });
  if (r.status !== 0) {
    console.error(`ERRO em ${rotulo}: ${String(r.stderr || r.stdout || '').trim()}`);
    process.exit(1);
  }
  return String(r.stdout || '');
}

/** Le os SANs do certificado atual (para --todos). */
function sansAtuais() {
  const arq = path.join(DIR, 'servidor.crt');
  if (!fs.existsSync(arq)) return { dns: [], ips: [] };
  const r = spawnSync(openssl, ['x509', '-in', 'servidor.crt', '-noout', '-ext', 'subjectAltName'],
    { encoding: 'utf8', cwd: DIR });
  const texto = String(r.stdout || '');
  const dns = [...texto.matchAll(/DNS:([^,\s]+)/g)].map((m) => m[1]);
  const ips = [...texto.matchAll(/IP Address:([^,\s]+)/g)].map((m) => m[1]);
  return { dns, ips };
}

const detectado = detectarIdentidades();
const anteriores = MANTER ? sansAtuais() : { dns: [], ips: [] };

for (const extra of EXTRAS) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(extra)) detectado.ips.push(extra);
  else detectado.dns.push(extra.toLowerCase());
}

const HOSTS = [...new Set([...anteriores.dns, ...detectado.dns])];
const IPS = [...new Set([...anteriores.ips, ...detectado.ips])];

console.log('Identidades desta maquina:');
console.log(`  nomes: ${HOSTS.join(', ')}`);
console.log(`  IPs  : ${IPS.join(', ')}\n`);

const linhasAlt = [
  ...HOSTS.map((h, i) => `DNS.${i + 1} = ${h}`),
  ...IPS.map((ip, i) => `IP.${i + 1} = ${ip}`),
].join('\n');

const cnfCa = [
  '[req]', 'distinguished_name = dn', 'prompt = no', '[dn]',
  'C = BR', 'ST = SP', 'L = Sao Paulo', `O = ${ORG}`, `CN = ${CA_CN}`,
  '[v3_ca]',
  'basicConstraints = critical, CA:TRUE, pathlen:0',
  'keyUsage = critical, keyCertSign, cRLSign',
  'subjectKeyIdentifier = hash',
  '',
].join('\n');
fs.writeFileSync(path.join(DIR, 'ca.cnf'), cnfCa);

const cnf = [
  '[req]', 'distinguished_name = dn', 'prompt = no', '[dn]',
  'C = BR', 'ST = SP', 'L = Sao Paulo', `O = ${ORG}`, `CN = ${HOSTS[0]}`,
  '[ext_servidor]',
  'basicConstraints = critical, CA:FALSE',
  'keyUsage = critical, digitalSignature, keyEncipherment',
  'extendedKeyUsage = serverAuth',
  'subjectKeyIdentifier = hash',
  'authorityKeyIdentifier = keyid, issuer',
  'subjectAltName = @alt',
  '[alt]',
  linhasAlt,
  '',
].join('\n');
fs.writeFileSync(path.join(DIR, 'servidor.cnf'), cnf);

const temCA = fs.existsSync(path.join(DIR, 'ca.crt')) && fs.existsSync(path.join(DIR, 'ca.key'));

if (temCA && !NOVA_CA) {
  console.log('[1/4] CA existente reaproveitada — as maquinas que ja a tem continuam validas.');
} else {
  if (temCA && NOVA_CA) {
    console.log('[1/4] ATENCAO: gerando CA NOVA. Todas as maquinas precisam instalar o novo ca.crt.');
    fs.copyFileSync(path.join(DIR, 'ca.crt'), path.join(DIR, 'ca-anterior.crt'));
    fs.copyFileSync(path.join(DIR, 'ca.key'), path.join(DIR, 'ca-anterior.key'));
  } else {
    console.log('[1/4] Criando a autoridade certificadora local...');
  }
  rodar(['genrsa', '-out', 'ca.key', '4096'], 'gerar chave da CA');
  rodar(['req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', String(DIAS_CA),
    '-out', 'ca.crt', '-config', 'ca.cnf', '-extensions', 'v3_ca'], 'criar a CA');
}

console.log('[2/4] Gerando chave e pedido do servidor...');
rodar(['genrsa', '-out', 'servidor.key', '2048'], 'gerar chave do servidor');
rodar(['req', '-new', '-key', 'servidor.key', '-out', 'servidor.csr', '-config', 'servidor.cnf'], 'criar CSR');

console.log(`[3/4] Assinando o certificado de servidor (${DIAS} dias)...`);
rodar(['x509', '-req', '-in', 'servidor.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
  '-CAcreateserial', '-out', 'servidor.crt', '-days', String(DIAS), '-sha256',
  '-extfile', 'servidor.cnf', '-extensions', 'ext_servidor'], 'assinar');

console.log('[4/4] Conferindo...');
const textoCa = String(spawnSync(openssl, ['x509', '-in', 'ca.crt', '-noout', '-text'],
  { encoding: 'utf8', cwd: DIR }).stdout || '');
const qtdBC = (textoCa.match(/Basic Constraints/g) || []).length;
if (!/CA:TRUE/.test(textoCa) || qtdBC !== 1) {
  console.error('ERRO: CA malformada (Basic Constraints ausente ou duplicada). Nada foi aplicado.');
  process.exit(1);
}
const verifica = spawnSync(openssl, ['verify', '-CAfile', 'ca.crt', 'servidor.crt'],
  { encoding: 'utf8', cwd: DIR });
if (verifica.status !== 0) {
  console.error('ERRO: a cadeia nao validou. Nada foi aplicado.');
  process.exit(1);
}
console.log(`      cadeia: ${String(verifica.stdout || '').trim()}`);
console.log(`      SAN: ${HOSTS.length} nome(s) + ${IPS.length} IP(s)`);

console.log('\nPronto. Reinicie o servidor para ele usar o novo certificado.');
console.log('  certs/ca.crt      -> instalar nas maquinas (instalar-certificado.bat)');
console.log('  certs/servidor.*  -> usados pelo web-config.json');
