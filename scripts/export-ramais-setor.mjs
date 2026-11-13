/**
 * Gera o relatorio ramal x setor a partir das views do banco.
 *
 * Dois formatos:
 *  - ramais-setores.csv   : uma linha por (telefone x setor). Ramal em 2 setores
 *                           aparece 2x, com os mesmos dados de equipamento.
 *  - ramais-setores.json  : uma linha por telefone, com array "setores".
 */
import fs from 'node:fs';
import { openDb } from '../src/lib/db.js';

const dbPath = process.argv[2] || 'voip.sqlite';
const db = openDb(dbPath);
const all = (s, ...p) => db.prepare(s).all(...p);

// ---- CSV: uma linha por telefone x setor (view ja faz o produto) ----
const rows = all(
  `SELECT ramal, setor, andar, predio, ala, ip, mac, model, firmware,
          online, missing_since, last_seen, ocorrencias
   FROM v_ramal_setor
   ORDER BY CAST(ramal AS INTEGER), ip, setor`,
);

const campos = ['ramal', 'setor', 'andar', 'predio', 'ala', 'ip', 'mac', 'model',
  'firmware', 'status', 'missing_since', 'last_seen', 'observacao'];

const esc = (v) => (v == null ? '' : /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const statusDe = (r) => (r.online === 1 ? 'online' : r.online === 0 ? 'desaparecido' : 'nao verificado');
const observacaoDe = (r) => {
  if (!r.ramal) return 'aparelho sem conta SIP (sem ramal)';
  if (!r.setor) return 'ramal nao consta na planilha de setores';
  if (r.ocorrencias > 1) return `linha repetida ${r.ocorrencias}x na planilha`;
  return '';
};

const linhas = [campos.join(';')];
for (const r of rows) {
  linhas.push([
    r.ramal, r.setor, r.andar, r.predio, r.ala, r.ip, r.mac, r.model, r.firmware,
    statusDe(r), r.missing_since, r.last_seen, observacaoDe(r),
  ].map(esc).join(';'));
}

// CSV com BOM UTF-8 para o Excel em portugues abrir com acentos corretos
fs.writeFileSync('ramais-setores.csv', '\uFEFF' + linhas.join('\r\n') + '\r\n', 'utf8');

// ---- JSON: uma entrada por telefone, com todos os setores ----
const devs = all(
  `SELECT ip, ramal, mac, model, firmware, online, missing_since, last_seen, first_seen, qtd_setores
   FROM v_device_setores ORDER BY CAST(ramal AS INTEGER), ip`,
);
const porIp = new Map();
for (const r of rows) {
  if (!porIp.has(r.ip)) porIp.set(r.ip, []);
  if (r.setor) {
    porIp.get(r.ip).push({ setor: r.setor, andar: r.andar, predio: r.predio, ala: r.ala, ocorrencias: r.ocorrencias });
  }
}

const json = devs.map((d) => ({
  ...d,
  status: statusDe(d),
  setores: porIp.get(d.ip) || [],
}));
fs.writeFileSync('ramais-setores.json', JSON.stringify(json, null, 2), 'utf8');

const comSetor = devs.filter((d) => d.qtd_setores > 0).length;
const multi = devs.filter((d) => d.qtd_setores > 1).length;
console.log(`\nrelatorio gerado:`);
console.log(`  ramais-setores.csv   (${rows.length} linhas = telefone x setor)`);
console.log(`  ramais-setores.json  (${json.length} telefones)`);
console.log(`  com setor: ${comSetor} | em 2+ setores: ${multi} | sem setor: ${devs.length - comSetor}`);
db.close();
