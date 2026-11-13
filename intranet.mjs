import http from 'node:http';
import fs from 'node:fs';

function get(url) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, { timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
  });
}

const url = 'http://smshmacn397:5000/ramais';
const { status, body } = await get(url);
console.log('status:', status, '| bytes:', body.length);
fs.writeFileSync('intranet-ramais.html', body, 'utf8');

// mostra as tags de tabela/headers para entender a estrutura
const headers = [...body.matchAll(/<th[^>]*>([\s\S]{0,60}?)<\/th>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
console.log('\nheaders da tabela:', JSON.stringify(headers));

const linhas = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
console.log('linhas <tr>:', linhas.length);
console.log('\n--- primeiras 3 linhas de dados ---');
for (const l of linhas.slice(1, 4)) {
  const cels = [...l[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1].replace(/<[^>]+>/g, '').trim());
  console.log(JSON.stringify(cels));
}
