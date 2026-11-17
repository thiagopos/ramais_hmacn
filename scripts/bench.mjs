/**
 * Benchmark reproduzivel do servidor web.
 *
 * Mede cada requisicao do carregamento, o bloco paralelo e concorrencia.
 * Salva o resultado em benchmarks/<label>.json para comparacao posterior.
 *
 * Uso:
 *   node scripts/bench.mjs                       # rotulo automatico
 *   node scripts/bench.mjs antes                 # rotulo manual
 *   node scripts/bench.mjs --compare antes depois
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const HOST = process.env.BENCH_HOST || '127.0.0.1';
const PORT = Number(process.env.BENCH_PORT || 8181);
const H = { host: HOST, port: PORT };
const CASE = (() => {
  const i = process.argv.indexOf('--compare');
  if (i > 0) return { compare: process.argv.slice(i + 1, i + 3) };
  return { label: process.argv[2] || 'run' };
})();

function req(method, p, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve) => {
    const h = { ...headers };
    let payload;
    if (body) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = body; }
    if (payload) h['Content-Length'] = Buffer.byteLength(payload);
    if (cookie) h.Cookie = cookie;
    const t0 = process.hrtime.bigint();
    const r = http.request({ ...H, method, path: p, headers: h, timeout: 120000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          ms: Number(process.hrtime.bigint() - t0) / 1e6,
          bytes: buf.length,
          headers: res.headers,
          body: buf,
        });
      });
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, ms: 1e9, bytes: 0, headers: {}, body: Buffer.alloc(0) }); });
    r.on('error', () => resolve({ status: -1, ms: 1e9, bytes: 0, headers: {}, body: Buffer.alloc(0) }));
    if (payload) r.write(payload);
    r.end();
  });
}

/** Mediana de N execucoes (menos sensivel a picos). */
async function med(fn, n = 5) {
  const vals = [];
  for (let i = 0; i < n; i++) vals.push((await fn()).ms);
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

const login = await req('POST', '/login', { body: 'password=1234' });
const cookie = (login.headers['set-cookie']?.[0] || '').split(';')[0];
const GZ = { 'Accept-Encoding': 'gzip, deflate, br' };

const res = {
  label: CASE.label || 'compare',
  at: new Date().toISOString(),
  host: `${HOST}:${PORT}`,
  metrics: {},
};

console.log(`\n=== BENCHMARK "${CASE.label}" — ${HOST}:${PORT} ===\n`);

// ---------------- endpoints ----------------
const endpoints = [
  ['html', 'GET', '/', 'HTML da pagina'],
  ['phones', 'GET', '/api/phones', 'inventario (JSON)'],
  ['stats', 'GET', '/api/stats', 'cards do topo'],
  ['scope', 'GET', '/api/scope', 'subtitulo'],
  ['monitorStatus', 'GET', '/api/monitor/status', 'estado do monitor'],
];

console.log('--- requisicoes individuais (mediana de 5) ---');
for (const [key, method, p, desc] of endpoints) {
  const ms = await med(() => req(method, p, { cookie }));
  const r = await req(method, p, { cookie });
  const rGz = await req(method, p, { cookie, headers: GZ });
  res.metrics[key] = {
    ms: Math.round(ms),
    bytes: r.bytes,
    bytesGzip: rGz.headers['content-encoding'] ? rGz.bytes : null,
    cacheControl: r.headers['cache-control'] || null,
    etag: !!r.headers.etag,
  };
  const kb = (r.bytes / 1024).toFixed(0);
  const gz = rGz.headers['content-encoding'] ? ` | gzip ${(rGz.bytes / 1024).toFixed(0)}KB` : ' | sem gzip';
  console.log(`  ${desc.padEnd(22)} ${String(Math.round(ms)).padStart(6)} ms  ${kb.padStart(5)} KB${gz}`);
}

// ---------------- bloco paralelo (como a pagina faz) ----------------
console.log('\n--- carregamento da pagina (Promise.all) ---');
const blocos = [];
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  await Promise.all([
    req('GET', '/api/phones', { cookie }),
    req('GET', '/api/stats', { cookie }),
    req('GET', '/api/scope', { cookie }),
  ]);
  blocos.push(Date.now() - t0);
}
blocos.sort((a, b) => a - b);
const blocoMediana = blocos[Math.floor(blocos.length / 2)];
res.metrics.pageLoad = { ms: blocoMediana };
console.log(`  bloco de dados (mediana): ${blocoMediana} ms`);

// ---------------- concorrencia (3 usuarios) ----------------
console.log('\n--- 3 usuarios simultaneos em /api/stats ---');
const t0 = Date.now();
const conc = await Promise.all([
  req('GET', '/api/stats', { cookie }),
  req('GET', '/api/stats', { cookie }),
  req('GET', '/api/stats', { cookie }),
]);
const wall = Date.now() - t0;
res.metrics.concurrency = {
  wall: wall,
  individual: conc.map((x) => Math.round(x.ms)),
  serialized: conc.reduce((a, x) => a + x.ms, 0) > 2.2 * Math.max(...conc.map((x) => x.ms)),
};
console.log(`  individuais: ${conc.map((x) => Math.round(x.ms)).join(', ')} ms`);
console.log(`  wall total : ${wall} ms  ${res.metrics.concurrency.serialized ? '(serializado — bloqueia)' : '(concorrente)'}`);

// ---------------- recarga com revalidacao (304) ----------------
console.log('\n--- recarga do navegador (If-None-Match -> 304) ---');
for (const [key, p] of [['phones', '/api/phones'], ['stats', '/api/stats'], ['html', '/']]) {
  const first = await req('GET', p, { cookie, headers: GZ });
  const etag = first.headers.etag;
  if (!etag) {
    console.log(`  ${p.padEnd(22)} sem ETag (nao revalida)`);
    continue;
  }
  const ms304 = await med(() => req('GET', p, { cookie, headers: { ...GZ, 'If-None-Match': etag } }), 5);
  const r304 = await req('GET', p, { cookie, headers: { ...GZ, 'If-None-Match': etag } });
  res.metrics[key + 'Warm'] = { ms: Math.round(ms304), bytes: r304.bytes, status: r304.status };
  console.log(`  ${p.padEnd(22)} ${String(Math.round(ms304)).padStart(6)} ms  status ${r304.status}  ${r304.bytes} B`);
}

// ---------------- veredito ----------------
const nota = blocoMediana <= 50 ? 'EXCELENTE' : blocoMediana <= 300 ? 'BOM' : blocoMediana <= 1000 ? 'ACEITAVEL' : 'RUIM';
res.veredito = { pageLoadMs: blocoMediana, nota };
console.log(`\n>>> carregamento: ${blocoMediana} ms — ${nota}\n`);

// ---------------- salvar ----------------
const dir = path.resolve('benchmarks');
fs.mkdirSync(dir, { recursive: true });
if (!CASE.compare) {
  const file = path.join(dir, `${CASE.label}.json`);
  fs.writeFileSync(file, JSON.stringify(res, null, 2));
  console.log(`salvo em ${file}`);
} else {
  console.log('(modo comparativo: nao salvou resultado)');
}

// ---------------- comparar ----------------
if (CASE.compare) {
  const [a, b] = CASE.compare.map((l) => {
    const f = path.join(dir, `${l}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  });
  if (a && b) {
    console.log(`\n=== COMPARATIVO: ${a.label} -> ${b.label} ===\n`);
    console.log('  metrica                antes        depois      ganho');
    const chaves = new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)]);
    for (const k of chaves) {
      const x = a.metrics[k]?.ms ?? a.metrics[k]?.wall;
      const y = b.metrics[k]?.ms ?? b.metrics[k]?.wall;
      if (x == null || y == null) continue;
      const g = y > 0 ? (x / y) : Infinity;
      const sinal = y < x ? '>' : y > x ? '<' : '=';
      console.log(`  ${k.padEnd(20)} ${String(Math.round(x)).padStart(8)}ms ${String(Math.round(y)).padStart(10)}ms   ${g >= 1 ? g.toFixed(1) + 'x' : (1 / g).toFixed(1) + 'x pior'} ${sinal}`);
    }
    const dA = a.metrics.phones?.bytes;
    const dB = b.metrics.phones?.bytes;
    if (dA && dB) console.log(`\n  payload /api/phones: ${(dA / 1024).toFixed(0)}KB -> ${(dB / 1024).toFixed(0)}KB`);
  } else {
    console.log('\n(comparativo: arquivo nao encontrado)');
  }
}
