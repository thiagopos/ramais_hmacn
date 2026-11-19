/**
 * Importa o cadastro de impressoras do projeto antigo (printers-snmp).
 *
 * Le data/printers.json e grava em impressoras (do nosso banco): IP, modelo,
 * serie e o setor ja separado em nome + andar.
 *
 * O formato do setor vem como "0 - ALMOXARIFADO Administracao": andar, nome do
 * setor e local de instalacao no MESMO texto. O parser abaixo separa isso —
 * a mesma heuristica do projeto antigo, mas isolada e testavel.
 *
 * Uso:
 *   node scripts/importar-impressoras.mjs                 # caminho padrao
 *   node scripts/importar-impressoras.mjs <arquivo.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb, fecharConexoes } from '../src/lib/db.js';
import { criarTabelasImpressoras, gravarVersaoImpressoras } from '../src/lib/impressoras-schema.js';

const PADRAO = 'C:/Users/x344942/Documents/code/FASE5/printers-snmp/data/printers.json';
const dbPath = process.argv[3] || 'voip.sqlite';
const arquivo = process.argv[2] || PADRAO;

if (!fs.existsSync(arquivo)) {
  console.error(`arquivo nao encontrado: ${arquivo}`);
  process.exit(1);
}

/**
 * Separa "0 - ALMOXARIFADO Administracao" em andar / setor / local.
 *
 * O nome do setor fica em CAPS e o local de instalacao vem depois, em
 * minusculas (ex.: "Administracao"). Percorremos as palavras ate achar a
 * primeira que tem mais de uma letra minuscula — dali em diante e o local.
 * Se nada casar, tudo e nome do setor.
 */
export function separarSetor(valor) {
  const txt = String(valor || '').trim();
  const m = txt.match(/^(\d+)\s*-\s*(.+)$/);
  if (!m) return { andar: null, setor: txt || null, local: null };

  const andar = String(Number(m[1]));
  const resto = m[2].trim();
  const palavras = resto.split(/\s+/);

  let corte = palavras.length;
  for (let i = 0; i < palavras.length; i++) {
    // conta letras minusculas ASCII (acentuadas nao entram, por isso CAPS)
    if ((palavras[i].match(/[a-z]/g) || []).length > 1) { corte = i; break; }
  }

  const setor = palavras.slice(0, corte).join(' ') || resto;
  const local = palavras.slice(corte).join(' ') || null;
  return { andar, setor, local };
}

const bruto = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
const lista = Array.isArray(bruto) ? bruto : Object.values(bruto);

// os cabecalhos vem com acento corrompido no arquivo original
const campo = (o, ...nomes) => {
  for (const n of nomes) {
    if (o[n] != null) return o[n];
    const chave = Object.keys(o).find((k) => k.toUpperCase().startsWith(n.toUpperCase()));
    if (chave != null) return o[chave];
  }
  return null;
};

const db = openDb(dbPath);
criarTabelasImpressoras(db);
gravarVersaoImpressoras(db);

const agora = new Date().toISOString();
const sql = db.prepare(`
  INSERT INTO impressoras (ip, serie, serie_cadastro, modelo, setor, local, andar, ativo, criado_em)
  VALUES (@ip, @serie, @serie, @modelo, @setor, @local, @andar, 1, @criado)
  ON CONFLICT(ip) DO UPDATE SET
    serie_cadastro = excluded.serie_cadastro,
    modelo = COALESCE(excluded.modelo, impressoras.modelo),
    setor = COALESCE(excluded.setor, impressoras.setor),
    local = COALESCE(excluded.local, impressoras.local),
    andar = COALESCE(excluded.andar, impressoras.andar)
`);

let inseridas = 0, puladas = 0, semIp = 0;
let comLocal = 0;
const setores = new Set();
const locais = new Set();

db.exec('BEGIN');
try {
  for (const item of lista) {
    const ip = String(campo(item, 'IP Liberty') || '').trim();
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) { semIp++; continue; }

    const modelo = campo(item, 'MODELO');
    const serie = campo(item, 'SERIE', 'S\u00c9RIE', 'SÉRIE');
    const setorBruto = campo(item, 'SETOR');
    const { andar, setor, local } = separarSetor(setorBruto);

    if (setor) setores.add(setor);
    if (local) { locais.add(`${setor} / ${local}`); comLocal++; }

    sql.run({
      ip,
      serie: serie ? String(serie).trim() : null,
      modelo: modelo ? String(modelo).trim() : null,
      setor: setor || null,
      local: local || null,
      andar: andar || null,
      criado: agora,
    });
    inseridas++;
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('falhou, nada foi gravado:', e.message);
  process.exit(1);
}

const total = db.prepare('SELECT COUNT(*) c FROM impressoras').get().c;
const porModelo = db.prepare('SELECT modelo, COUNT(*) c FROM impressoras GROUP BY modelo ORDER BY c DESC').all();

console.log(`arquivo: ${arquivo}`);
console.log(`registros no arquivo: ${lista.length}`);
console.log(`importados           : ${inseridas}`);
console.log(`sem IP valido        : ${semIp}`);
console.log(`com local de instalacao: ${comLocal}`);
console.log(`setores distintos    : ${setores.size}`);
console.log(`locais distintos     : ${locais.size}`);
console.log(`total no banco       : ${total}\n`);
console.log('por modelo:');
for (const m of porModelo) console.log(`  ${String(m.modelo).padEnd(20)} ${m.c}`);

console.log('\nsetores com mais de uma impressora (local de cada uma):');
for (const s of db.prepare(`SELECT setor, COUNT(*) n FROM impressoras
                            WHERE setor IS NOT NULL GROUP BY setor HAVING n > 1
                            ORDER BY n DESC LIMIT 6`).all()) {
  console.log(`  ${s.setor} (${s.n})`);
  for (const l of db.prepare(`SELECT ip, local FROM impressoras WHERE setor = ? ORDER BY ip`).all(s.setor)) {
    console.log(`      ${l.ip.padEnd(15)} ${l.local || '(sem local)'}`);
  }
}

fecharConexoes();
