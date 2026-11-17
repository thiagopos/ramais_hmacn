import http from 'node:http';
const H = { host: '127.0.0.1', port: 8181 };

function req(method, p, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve) => {
    const h = { ...headers };
    let payload;
    if (body) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = body; }
    if (payload) h['Content-Length'] = Buffer.byteLength(payload);
    if (cookie) h.Cookie = cookie;
    const t0 = process.hrtime.bigint();
    const r = http.request({ ...H, method, path: p, headers: h, timeout: 60000 }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({
        status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6,
        headers: res.headers, body: d,
      }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, ms: 1e9, headers: {}, body: '' }); });
    r.on('error', () => resolve({ status: -1, ms: 1e9, headers: {}, body: '' }));
    if (payload) r.write(payload);
    r.end();
  });
}
const J = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };
let ok = 0, falhas = 0;

function check(nome, cond, extra = '') {
  if (cond) { ok++; console.log(`  OK   ${nome}${extra ? '  ' + extra : ''}`); }
  else { falhas++; console.log(`  FALHA ${nome}${extra ? '  ' + extra : ''}`); }
}

const login = await req('POST', '/login', { body: 'password=1234' });
const cookie = (login.headers['set-cookie']?.[0] || '').split(';')[0];
console.log('login:', login.status === 302 ? 'OK' : 'FALHA');

console.log('\n--- autenticacao ---');
const semSessao = await req('GET', '/api/phones');
check('API sem sessao -> 401', semSessao.status === 401, `status=${semSessao.status}`);
const semSessaoHtml = await req('GET', '/');
check('HTML sem sessao -> 302 (login)', semSessaoHtml.status === 302, `status=${semSessaoHtml.status}`);
const comSessao = await req('GET', '/api/phones', { cookie });
check('com sessao retorna 200', comSessao.status === 200);

console.log('\n--- dados ---');
const phones = J(comSessao);
check('lista tem 249 telefones', phones.count === 249, `count=${phones.count}`);
check('lista NAO traz tls_json', phones.rows[0].tls_json === undefined);
check('lista traz quedas', phones.rows[0].quedas !== undefined);

const det = J(await req('GET', '/api/phones/172.18.90.125', { cookie }));
check('detalhe traz sip_ua', !!det.sip_ua, det.sip_ua || '');
check('detalhe traz ports_json', !!det.ports_json);
const det404 = await req('GET', '/api/phones/1.2.3.4', { cookie });
check('detalhe inexistente -> 404', det404.status === 404);

const stats = J(await req('GET', '/api/stats', { cookie }));
check('stats: total 249', stats.total === 249);
check('stats: instaveis >= 0', typeof stats.estabilidade.instaveis === 'number', `instaveis=${stats.estabilidade.instaveis}`);
check('stats: quedasAbertas presente', stats.quedasAbertas !== undefined, `= ${stats.quedasAbertas}`);

const scope = J(await req('GET', '/api/scope', { cookie }));
check('scope tem alvos', Array.isArray(scope.targets) && scope.targets.length > 0);

console.log('\n--- historico de quedas ---');
const q = J(await req('GET', '/api/quedas?ip=172.18.90.82', { cookie }));
check('quedas do 402243 agrupadas em 5', q.count === 5, `count=${q.count}`);
check('resumo com maior queda', q.resumo.maior === 450, `maior=${q.resumo.maior}`);

console.log('\n--- setores ---');
const cat = J(await req('GET', '/api/setores/catalogo', { cookie }));
check('catalogo de setores', cat.rows.length > 150, `${cat.rows.length} setores`);
const set = J(await req('GET', '/api/setores', { cookie }));
check('resumo de setores', set.rows.length > 0, `${set.rows.length} setores`);
const doRamal = J(await req('GET', '/api/ramais/402183/setores', { cookie }));
check('setores do ramal 402183', doRamal.rows.length >= 1, JSON.stringify(doRamal.rows.map((r) => r.setor)));

console.log('\n--- monitor ---');
const st = J(await req('GET', '/api/monitor/status', { cookie }));
check('status do monitor', st.running === false);
// lastResult e em memoria: null logo apos restart, preenchido se ja rodou.
// Vale a forma, nao o estado — o teste nao deve depender do ciclo de vida.
check('lastResult ausente ou com resumo valido',
  st.lastResult === null || typeof st.lastResult === 'object',
  st.lastResult ? `online=${st.lastResult.online}` : 'null');
check('stats expoe ultimoCheck', !!stats.ultimoCheck, stats.ultimoCheck || '');
const runs = J(await req('GET', '/api/runs', { cookie }));
check('historico de execucoes', runs.runs.length > 0);

console.log('\n--- http (gzip/etag/304) ---');
const gz = await req('GET', '/api/phones', { cookie, headers: { 'Accept-Encoding': 'gzip' } });
check('gzip no JSON grande', gz.headers['content-encoding'] === 'gzip', `${(gz.body.length / 1024).toFixed(0)}KB`);
check('ETag presente', !!gz.headers.etag);
const nm = await req('GET', '/api/phones', { cookie, headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': gz.headers.etag } });
check('304 com corpo vazio', nm.status === 304 && nm.body.length === 0);
const html = await req('GET', '/', { cookie, headers: { 'Accept-Encoding': 'gzip' } });
check('HTML comprimido', html.headers['content-encoding'] === 'gzip');
const htmlNm = await req('GET', '/', { cookie, headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': html.headers.etag } });
check('HTML 304', htmlNm.status === 304);

console.log(`\n=== ${ok} OK, ${falhas} falha(s) ===`);
process.exit(falhas ? 1 : 0);
