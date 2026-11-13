/**
 * Gera o relatorio ramal x setor (CSV e JSON) a partir do banco.
 * Uso: node scripts/export-ramais-setor.mjs [--db voip.sqlite]
 */
import fs from 'node:fs';
import { openDb } from '../src/lib/db.js';

const dbPath = process.argv[2] || 'voip.sqlite';
const db = openDb(dbPath);
const all = (s, ...p) => db.prepare(s).all(...p);

const devs = all(
  `SELECT ip, ramal, mac, model, firmware, online, missing_since, last_seen
   FROM devices WHERE is_phone = 1 ORDER BY CAST(ramal AS INTEGER), ip`,
);

const rows = [];
for (const d of devs) {
  const curto = (d.ramal || '').replace(/^(40|41)/, '');
  const setores = curto
    ? all(
        `SELECT s.setor, s.andar, s.predio, s.ala, sr.linha_origem
         FROM setor_ramais sr JOIN setores s ON s.id = sr.setor_id
         WHERE sr.ramal_curto = ? ORDER BY sr.id`,
        curto,
      )
    : [];

  if (setores.length === 0) {
    rows.push({
      ...d,
      setor: null, andar: null, predio: null, ala: null,
      observacao: d.ramal ? 'ramal nao consta na planilha de setores' : 'aparelho sem conta SIP (sem ramal)',
    });
  } else {
    for (const s of setores) {
      rows.push({
        ...d,
        setor: s.setor,
        andar: s.andar,
        predio: s.predio,
        ala: s.ala,
        observacao: setores.length > 1 ? `ramal em ${setores.length} setores na planilha` : null,
      });
    }
  }
}

// CSV
const campos = ['ramal', 'setor', 'andar', 'predio', 'ala', 'ip', 'mac', 'model', 'firmware',
  'status', 'missing_since', 'last_seen', 'observacao'];
const esc = (v) => (v == null ? '' : /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const linhas = [campos.join(';')];
for (const r of rows) {
  linhas.push(campos.map((c) => esc(r[c === 'status' ? null : c] ?? (c === 'status' ? (r.online === 1 ? 'online' : r.online === 0 ? 'desaparecido' : 'nao verificado') : null))).join(';'));
}
// CSV com BOM UTF-8 para o Excel em portugues abrir com acentos corretos
fs.writeFileSync('ramais-setores.csv', '\uFEFF' + linhas.join('\r\n') + '\r\n', 'utf8');

// JSON
fs.writeFileSync('ramais-setores.json', JSON.stringify(rows, null, 2), 'utf8');

const comSetor = new Set(rows.filter((r) => r.setor).map((r) => r.ramal));
console.log(`\nrelatorio gerado:`);
console.log(`  ramais-setores.csv   (${rows.length} linhas)`);
console.log(`  ramais-setores.json  (${rows.length} registros)`);
console.log(`  telefones com setor: ${comSetor.size}`);
db.close();
