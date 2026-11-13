import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const db = new DatabaseSync('voip.sqlite');
const all = (s, ...p) => db.prepare(s).all(...p);
const intranet = JSON.parse(fs.readFileSync('intranet-ramais.json', 'utf8'));

const curto = (r) => (r || '').replace(/^(40|41)/, '');
const porRamal = new Map();
for (const r of intranet) {
  if (!porRamal.has(r.ramal)) porRamal.set(r.ramal, []);
  porRamal.get(r.ramal).push(r);
}

const devs = all("SELECT ip, ramal, online FROM devices WHERE is_phone=1 ORDER BY CAST(ramal AS INTEGER)");
const planilha = new Set(all('SELECT DISTINCT ramal_curto FROM setor_ramais').map((r) => r.ramal_curto));

let comSetorPlanilha = 0;
let soIntranet = [];
let semNada = [];
let conflito = [];

for (const d of devs) {
  if (!d.ramal) { semNada.push({ ...d, motivo: 'sem ramal' }); continue; }
  const c = curto(d.ramal);
  if (planilha.has(c)) { comSetorPlanilha++; continue; }
  // nao esta na planilha -> olha a intranet
  const intra = porRamal.get(c);
  if (intra) soIntranet.push({ ip: d.ip, ramal: d.ramal, curto: c, andar: intra[0].andar, setor: intra.map((x) => x.setor).join(' | ') });
  else semNada.push({ ip: d.ip, ramal: d.ramal, curto: c, motivo: 'nao consta na planilha nem na intranet' });
}

console.log('=== CRUZAMENTO ===');
console.log('telefones na rede        :', devs.length);
console.log('com setor (planilha)     :', comSetorPlanilha);
console.log('sem setor na planilha    :', devs.length - comSetorPlanilha);
console.log('  -> ACHADOS na intranet :', soIntranet.length);
console.log('  -> sem setor em nenhuma:', semNada.length);

console.log('\n=== RAMAIS SEM SETOR QUE A INTRANET IDENTIFICA ===');
for (const r of soIntranet.sort((a, b) => +a.curto - +b.curto)) {
  console.log(` ${r.ramal} (${r.ip.padEnd(14)}) ${r.andar.padEnd(10)} ${r.setor}`);
}

console.log('\n=== CONTINUAM SEM SETOR ===');
for (const r of semNada) {
  console.log(` ${(r.ramal || '(sem ramal)').padEnd(9)} ${r.ip.padEnd(14)} ${r.motivo}`);
}

// ramais da intranet que a planilha nao tem
const intraSet = new Set(intranet.map((r) => r.ramal));
const soPlanilha = [...planilha].filter((r) => !intraSet.has(r)).sort();
console.log('\n=== na PLANILHA mas nao na INTRANET:', soPlanilha.length, '===');
console.log(' ', soPlanilha.join(', '));

// divergencias de setor para ramais em ambas
console.log('\n=== divergencias de setor (ramal em ambas as fontes) ===');
let div = 0;
for (const d of devs) {
  if (!d.ramal) continue;
  const c = curto(d.ramal);
  if (!planilha.has(c) || !intraSet.has(c)) continue;
  const pSet = all(`SELECT s.setor FROM setor_ramais sr JOIN setores s ON s.id=sr.setor_id WHERE sr.ramal_curto=?`, c).map((x) => x.setor);
  const iSet = [...new Set(porRamal.get(c).map((x) => x.setor))];
  const norm = (a) => a.map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const pn = new Set(pSet.map((x) => norm([x])[0]));
  const soEmIntra = iSet.filter((x) => !pn.has(norm([x])[0]));
  const soEmPlan = pSet.filter((x) => !iSet.some((y) => norm([y])[0] === norm([x])[0]));
  if (soEmIntra.length || soEmPlan.length) {
    div++;
    if (div <= 25) {
      console.log(` ${d.ramal} | planilha: ${pSet.join(', ') || '-'} | intranet: ${iSet.join(', ')}`);
    }
  }
}
console.log(` total de ramais com divergencia: ${div}`);
