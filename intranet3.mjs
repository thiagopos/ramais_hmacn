import http from 'node:http';
import fs from 'node:fs';

function get(url) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, { timeout: 20000 }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
  });
}

const js = await get('http://smshmacn397:5000/scripts/ramais.js');
console.log('ramais.js status:', js.status, '| bytes:', js.body.length);
fs.writeFileSync('intranet-ramais.js', js.body, 'utf8');
console.log('\n--- conteudo (primeiros 1500) ---');
console.log(js.body.slice(0, 1500));

// o HTML tambem pode ter os dados inline
const html = fs.readFileSync('intranet-ramais.html', 'utf8');
// procura padroes tipo "40XXX" ou "2XXX" seguidos de texto
const blocos = [...html.matchAll(/class="[^"]*(?:ramal|div-ramais|tabela)[^"]*"[^>]*>([\s\S]{0,400}?)<\/(?:div|td|tr)>/gi)];
console.log('\nblocos com classe ramal:', blocos.length);
for (const b of blocos.slice(0, 3)) console.log(' ', JSON.stringify(b[1].replace(/\s+/g, ' ').slice(0, 200)));
