import fs from 'node:fs';
const b = fs.readFileSync('intranet-ramais.html', 'utf8');
console.log('--- primeiros 900 chars ---');
console.log(b.slice(0, 900));

console.log('\n--- <script src> ---');
for (const m of b.match(/src=["'][^"']+["']/g) || []) console.log(' ', m);

console.log('\n--- referencias a /api/ ---');
const api = [...new Set(b.match(/["'`]\/[a-z0-9/_-]*api[a-z0-9/_-]*["'`]/gi) || [])];
console.log(' ', api.slice(0, 15).join(', '));

console.log('\n--- ocorrencias de "ramal" no html (contexto) ---');
let i = b.toLowerCase().indexOf('ramal');
let n = 0;
while (i >= 0 && n < 5) {
  console.log(' ...', JSON.stringify(b.slice(Math.max(0, i - 60), i + 100)));
  i = b.toLowerCase().indexOf('ramal', i + 200);
  n++;
}
