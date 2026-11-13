/**
 * Importa a planilha de setores para o SQLite.
 *
 * Regras:
 * - Ramais na planilha vem SEM o prefixo de 2 digitos (ex.: "2064" = ramal 402064).
 * - Varios ramais separados por virgula, com ou sem espaco: "2091, 2092" / "2087,2088".
 * - Linhas repetidas e ramais em dois setores SAO preservados (fonte fiel).
 *
 * Uso: node scripts/import-setores.mjs <arquivo.tsv> [--db voip.sqlite]
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/lib/db.js';

const src = process.argv[2];
const dbPath = process.argv[3] || 'voip.sqlite';

if (!src) {
  console.error('uso: node scripts/import-setores.mjs <arquivo.tsv> [db]');
  process.exit(1);
}

const db = openDb(dbPath);

// aplica o schema de setores
const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'sql', 'setores.sql'), 'utf8');
db.exec(schema);

const raw = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/).filter((l) => l.trim());

const header = lines[0].split('\t').map((h) => h.trim().toLowerCase());
const ix = (name) => header.indexOf(name);
const col = {
  ramal: ix('ramal'),
  setor: ix('setor'),
  andar: ix('andar'),
  predio: ix('predio'),
  ala: ix('ala'),
};
if (col.ramal < 0 || col.setor < 0) {
  console.error('cabeçalho inválido. esperado: ramal, email, setor, andar, predio, ala');
  process.exit(1);
}

// limpa importações anteriores (idempotente)
db.exec(`DELETE FROM setor_ramais; DELETE FROM setores;`);

const insSetor = db.prepare(
  `INSERT INTO setores (setor, andar, predio, ala, origem, created_at) VALUES (?, ?, ?, ?, 'planilha', ?)`,
);
const insRamal = db.prepare(
  `INSERT INTO setor_ramais (setor_id, ramal_curto, linha_origem) VALUES (?, ?, ?)`,
);

const now = new Date().toISOString();
let setores = 0;
let vinculos = 0;
const avisos = [];

db.exec('BEGIN');
for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split('\t');
  const ramaisRaw = (f[col.ramal] || '').trim();
  const setor = (f[col.setor] || '').trim();
  if (!setor) continue;

  const andar = (f[col.andar] || '').trim() || null;
  const predio = (f[col.predio] || '').trim() || null;
  const alaRaw = (f[col.ala] || '').trim();
  const ala = !alaRaw || /^null$/i.test(alaRaw) ? null : alaRaw;

  const info = insSetor.run(setor, andar, predio, ala, now);
  const setorId = Number(info.lastInsertRowid);
  setores++;

  for (const bruto of ramaisRaw.split(',')) {
    const r = bruto.trim();
    if (!r) continue;
    if (!/^\d{4}$/.test(r)) {
      avisos.push(`linha ${i + 1}: ramal "${r}" nao tem 4 digitos (setor: ${setor})`);
      continue;
    }
    insRamal.run(setorId, r, i + 1);
    vinculos++;
  }
}
db.exec('COMMIT');

db.close();

console.log(`\nimportado: ${setores} setores, ${vinculos} vinculos ramal->setor`);
if (avisos.length) {
  console.log(`\n${avisos.length} aviso(s):`);
  for (const a of avisos) console.log('  ' + a);
}
