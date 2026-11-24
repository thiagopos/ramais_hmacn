/**
 * Caca a ramais perdidos pelo predio. SCRIPT AVULSO — nao faz parte do sistema.
 *
 * Uso unico: procura telefones ALE em faixas que o sistema nao varre, para
 * descobrir aparelhos que migraram para fora do padrao.
 *
 *   node cacar-ramais.mjs                      # 192.168.48.x + 192.168.54.x
 *   node cacar-ramais.mjs 192.168.48.0/24 ...  # outras faixas
 *
 * NAO grava nada no banco: so lista o que encontrou.
 *
 * POR QUE SIP OPTIONS E NAO TCP:
 * o firewall da rede aceita conexao TCP na 5060 em QUALQUER endereco — testei
 * 10.99.99.99 (que nao existe) e abriu em 0ms. Portanto "porta 5060 aberta"
 * nao indica telefone. A unica resposta confiavel e o 200 OK do SIP, que traz
 * o ramal, o modelo e o MAC dentro.
 */
import net from 'node:net';
import { parseSipIdentity } from './src/lib/sipid.js';

const FAIXAS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['192.168.48.0/24', '192.168.54.0/24'];

const CONCORRENCIA = 128;
const TIMEOUT_MS = 1200;

/** Expande CIDR simples (a.b.c.d/nn) em lista de IPs. */
function expandir(cidr) {
  const m = String(cidr).trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) throw new Error(`faixa invalida: ${cidr} (use CIDR, ex.: 192.168.48.0/24)`);
  const base = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (bits < 16) throw new Error(`recuso varrer /${bits}: grande demais`);

  const inicio = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  const total = 2 ** (32 - bits);
  const rede = (inicio & (~0 << (32 - bits))) >>> 0;

  const ips = [];
  // pula o endereco de rede e o de broadcast do bloco
  for (let i = 1; i < total - 1; i++) {
    const n = (rede + i) >>> 0;
    ips.push(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
  }
  return ips;
}

/** Pergunta o SIP OPTIONS e devolve a identidade, ou null se nao for telefone. */
function sipOptions(ip) {
  return new Promise((resolve) => {
    let buf = '';
    let terminado = false;
    const fim = (v) => {
      if (terminado) return;
      terminado = true;
      try { s.destroy(); } catch { /* ja fechou */ }
      resolve(v);
    };
    const s = net.connect({ host: ip, port: 5060, timeout: TIMEOUT_MS });
    s.on('connect', () => {
      s.write(
        `OPTIONS sip:${ip} SIP/2.0\r\n`
        + `Via: SIP/2.0/TCP ${ip};branch=z9hG4bK${Math.random().toString(36).slice(2)}\r\n`
        + 'Max-Forwards: 70\r\n'
        + 'From: <sip:scan@local>;tag=chk\r\n'
        + `To: <sip:${ip}>\r\n`
        + `Call-ID: ${Date.now()}@scan\r\n`
        + 'CSeq: 1 OPTIONS\r\n'
        + 'Contact: <sip:scan@local;transport=tcp>\r\n'
        + 'Content-Length: 0\r\n\r\n',
      );
    });
    s.on('data', (d) => {
      buf += d.toString();
      // 100 Trying vem antes do 200 em alguns modelos: espera o 200
      if (buf.includes('200 OK')) fim(buf);
    });
    s.on('timeout', () => fim(buf.includes('200 OK') ? buf : null));
    s.on('error', () => fim(null));
  });
}

/** Roda a lista com concorrencia limitada. */
async function comLimite(itens, limite, tarefa) {
  const resultados = [];
  let i = 0;
  const operarios = Array.from({ length: limite }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= itens.length) return;
      resultados.push(await tarefa(itens[idx]));
    }
  });
  await Promise.all(operarios);
  return resultados;
}

const alvos = FAIXAS.flatMap(expandir);
console.log(`=== caca a ramais ===`);
console.log(`  faixas       : ${FAIXAS.join(', ')}`);
console.log(`  IPs a sondar : ${alvos.length}`);
console.log(`  concorrencia : ${CONCORRENCIA} | timeout ${TIMEOUT_MS}ms\n`);

const t0 = Date.now();
let feitos = 0;
const encontrados = [];

const resultados = await comLimite(alvos, CONCORRENCIA, async (ip) => {
  const raw = await sipOptions(ip);
  feitos++;
  if (feitos % 32 === 0) {
    process.stdout.write(`\r  sondando ${String(feitos).padStart(4)}/${alvos.length}  |  ${encontrados.length} telefone(s)   `);
  }
  if (!raw) return null;
  const id = parseSipIdentity(raw);
  if (!id?.ramal) return null; // respondeu mas nao e telefone ALE
  const achado = { ip, ramal: id.ramal, mac: id.mac, modelo: id.model, firmware: id.firmware };
  encontrados.push(achado);
  return achado;
});

process.stdout.write('\n\n');
const seg = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`  sondados    : ${alvos.length}`);
console.log(`  telefones   : ${encontrados.length}`);
console.log(`  duracao     : ${seg}s\n`);

if (!encontrados.length) {
  console.log('  Nenhum telefone encontrado nestas faixas.');
  process.exit(0);
}

// agrupa por faixa para leitura
const porFaixa = new Map();
for (const e of encontrados) {
  const faixa = e.ip.split('.').slice(0, 3).join('.') + '.x';
  if (!porFaixa.has(faixa)) porFaixa.set(faixa, []);
  porFaixa.get(faixa).push(e);
}

for (const [faixa, lista] of [...porFaixa.entries()].sort()) {
  console.log(`\n  ${faixa}  (${lista.length})`);
  lista.sort((a, b) => String(a.ramal).localeCompare(String(b.ramal)));
  console.log(`    ${'IP'.padEnd(16)} ${'RAMAL'.padEnd(8)} ${'MAC'.padEnd(18)} MODELO / FIRMWARE`);
  for (const e of lista) {
    console.log(`    ${e.ip.padEnd(16)} ${String(e.ramal).padEnd(8)} ${String(e.mac || '-').padEnd(18)} ${e.modelo || '-'} ${e.firmware || ''}`);
  }
}

// tabela pronta para colar em outro lugar
const csv = ['ip;ramal;mac;modelo;firmware',
  ...encontrados.map((e) => `${e.ip};${e.ramal};${e.mac || ''};${e.modelo || ''};${e.firmware || ''}`)].join('\n');
const fs = await import('node:fs');
const saida = `ramais-encontrados-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
fs.writeFileSync(saida, csv, 'utf8');
console.log(`\n  CSV salvo em: ${saida}`);
