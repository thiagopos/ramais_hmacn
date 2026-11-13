import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const db = new DatabaseSync('voip.sqlite');
const all = (s, ...p) => db.prepare(s).all(...p);
const intranet = JSON.parse(fs.readFileSync('intranet-ramais.json', 'utf8'));
const curto = (r) => (r || '').replace(/^(40|41)/, '');

const intraSet = new Set(intranet.map((r) => r.ramal));
const planSet = new Set(all('SELECT DISTINCT ramal_curto FROM setor_ramais').map((r) => r.ramal_curto));
const devSet = new Set(all("SELECT ramal FROM devices WHERE is_phone=1 AND ramal IS NOT NULL").map((d) => curto(d.ramal)));

console.log('=== CONTAGENS ===');
console.log('ramais UNICOS na intranet      :', intraSet.size, `(${intranet.length} registros, com duplicatas)`);
console.log('ramais UNICOS na planilha      :', planSet.size);
console.log('telefones com ramal na rede    :', devSet.size);

console.log('\n=== intranet x planilha ===');
const soIntra = [...intraSet].filter((r) => !planSet.has(r)).sort();
const soPlan = [...planSet].filter((r) => !intraSet.has(r)).sort();
const ambas = [...intraSet].filter((r) => planSet.has(r));
console.log('so na INTRANET :', soIntra.length, '->', soIntra.join(', '));
console.log('so na PLANILHA :', soPlan.length, '->', soPlan.join(', '));
console.log('em AMBAS       :', ambas.length);

console.log('\n=== onde estao os 8 telefones sem setor que a intranet acha? ===');
const achados = all("SELECT d.ip, d.ramal FROM devices d WHERE d.is_phone=1 AND d.ramal IS NOT NULL")
  .map((d) => ({ ...d, curto: curto(d.ramal) }))
  .filter((d) => !planSet.has(d.curto) && intraSet.has(d.curto))
  .sort((a, b) => +a.curto - +b.curto);
for (const a of achados) {
  const info = intranet.filter((r) => r.ramal === a.curto).map((r) => `${r.andar}:${r.setor}`);
  console.log(` ${a.ramal} (${a.ip}) -> ${info.join(' | ')}`);
}
console.log('total:', achados.length);

console.log('\n=== esses 8 estao entre os "so na INTRANET"? ===');
const achadosSet = new Set(achados.map((a) => a.curto));
console.log('sim:', achados.filter((a) => !planSet.has(a.curto)).length);
console.log('os que estao so na intranet mas NAO sao telefone da rede:',
  soIntra.filter((r) => !devSet.has(r)).join(', ') || '(nenhum)');

console.log('\n=== ramais da intranet que nao existem como telefone na rede ===');
const intraSemAparelho = [...intraSet].filter((r) => !devSet.has(r)).sort();
console.log(intraSemAparelho.length, '->', intraSemAparelho.join(', '));
