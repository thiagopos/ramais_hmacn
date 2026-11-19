/**
 * Migra setores (ramais) e setores/locais (impressoras) para a tabela unica
 * `locais`, com hierarquia pai/filho opcional.
 *
 * REGRAS aplicadas:
 *  - dados de ramal prevalecem: quando o mesmo lugar existe nos dois lados,
 *    andar/predio/ala vem de setores (planilha oficial do hospital)
 *  - hierarquia detectada apenas entre setores que JA EXISTEM, por prefixo
 *    de nome ("Centro Cirurgico" vira pai de "Centro Cirurgico RPA")
 *  - nome + pai + andar e a chave: "Coordenacao de Enfermagem" no 4o e no
 *    5o andar sao lugares diferentes e coexistem
 *  - nada e apagado sem --aplicar
 *
 * Uso:
 *   node scripts/migrar-locais.mjs            # simulacao (nao grava nada)
 *   node scripts/migrar-locais.mjs --aplicar  # grava de verdade
 */
import { openDb, fecharConexoes } from '../src/lib/db.js';
import {
  criarTabelasLocais, gravarVersaoLocais, normalizarAndar, rotuloAndar,
} from '../src/lib/locais.js';

const APLICAR = process.argv.includes('--aplicar');
const dbPath = (() => {
  const i = process.argv.indexOf('--db');
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : 'voip.sqlite';
})();

const db = openDb(dbPath);
criarTabelasLocais(db);

/** Normaliza nome para comparar: sem acento, minusculo, espaco unico. */
export function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.;,]+$/, '')
    .trim();
}

/** Expande abreviacoes comuns do cadastro antigo de impressoras. */
export function expandir(s) {
  return norm(s)
    .replace(/\baloj\.?\b/g, 'alojamento')
    .replace(/\bdir\b/g, 'diretoria')
    .replace(/\bcoord\.?\b/g, 'coordenacao')
    .replace(/\badmin\.?\b/g, 'administrativo')
    .replace(/\badm\b/g, 'administrativo')
    .replace(/\bps\b/g, 'pronto socorro')
    .trim();
}

console.log(`banco: ${dbPath}`);
console.log(`modo : ${APLICAR ? 'APLICANDO' : 'SIMULACAO (nada sera gravado)'}\n`);

/* ------------------------------------------------------------------ */
/* 1) Setores de ramal                                                 */
/* ------------------------------------------------------------------ */
const setoresRamal = db.prepare(`
  SELECT s.id, s.setor, s.andar, s.predio, s.ala, s.origem,
         (SELECT COUNT(*) FROM setor_ramais r WHERE r.setor_id = s.id) AS ramais
  FROM setores s ORDER BY s.setor
`).all();

console.log(`=== 1) setores de ramal: ${setoresRamal.length} ===`);

// detecta pai por prefixo, apenas entre setores existentes
const nomesNorm = setoresRamal.map((s) => ({ id: s.id, nome: s.setor, n: norm(s.setor) }));
function acharPai(nomeOriginal) {
  const alvo = norm(nomeOriginal);
  const candidatos = nomesNorm
    .filter((c) => c.n !== alvo && (alvo.startsWith(c.n + ' ') || alvo.startsWith(c.n + ' - ')))
    .sort((a, b) => b.n.length - a.n.length); // o mais especifico primeiro
  if (!candidatos.length) return null;
  // se houver mais de um candidato com o mesmo tamanho, fica ambiguo
  const maior = candidatos[0];
  const empatados = candidatos.filter((c) => c.n.length === maior.n.length);
  if (empatados.length > 1) return { ambiguo: true, candidatos: empatados.map((c) => c.nome) };
  return { nome: maior.nome, id: maior.id };
}

const comPai = [];
const ambiguos = [];
const semPai = [];
for (const s of setoresRamal) {
  const p = acharPai(s.setor);
  if (!p) semPai.push(s);
  else if (p.ambiguo) ambiguos.push({ setor: s.setor, candidatos: p.candidatos });
  else comPai.push({ setor: s.setor, pai: p.nome });
}

console.log(`  com pai detectado : ${comPai.length}`);
console.log(`  sem pai (raiz)    : ${semPai.length}`);
console.log(`  ambiguos          : ${ambiguos.length}`);
console.log('\n  amostra da hierarquia detectada:');
for (const c of comPai.slice(0, 10)) console.log(`    ${c.pai}  >  ${c.setor}`);
if (ambiguos.length) {
  console.log('\n  ambiguos (ficam como raiz):');
  for (const a of ambiguos.slice(0, 5)) console.log(`    "${a.setor}" poderia ser filho de: ${a.candidatos.join(' | ')}`);
}

/* ------------------------------------------------------------------ */
/* 2) Setores e locais de impressora                                   */
/* ------------------------------------------------------------------ */
const impSetores = db.prepare(`
  SELECT setor, COUNT(*) n FROM impressoras WHERE setor IS NOT NULL GROUP BY setor ORDER BY setor
`).all();
const impLocais = db.prepare(`
  SELECT setor, local, COUNT(*) n FROM impressoras WHERE setor IS NOT NULL GROUP BY setor, local
`).all();

console.log(`\n=== 2) impressoras: ${impSetores.length} setores, ${impLocais.length} pares setor+local ===`);

const mapaRamalNorm = new Map();
for (const s of setoresRamal) mapaRamalNorm.set(norm(s.setor), s);

/**
 * Os setores do cadastro de impressoras costumam ser GUARDA-CHUVA
 * ("FARMACIA", "DIR", "SAME") enquanto os de ramal sao o posto especifico
 * ("Farmacia Coordenacao", "Diretoria de Enfermagem").
 *
 * Adotamos como filhos somente quando:
 *  - o setor de impressora e prefixo de 2 OU MAIS setores de ramal
 *    (com 1 so, e mais provavel ser o MESMO lugar com nome mais curto:
 *     "FREQUENCIA" x "Frequencia e Pagamento", "DIR TECNICA" x
 *     "Diretoria tecnica Dr Valfredo" — adotar esses criaria hierarquia falsa)
 *  - o filho ainda NAO tem pai detectado por prefixo
 *    (evita disputa: "Diretoria de Apoio" ja e pai de "Diretoria de Apoio Tecnico")
 */
const filhosPorPrefixo = new Map(); // setor de impressora -> [setores de ramal]
for (const imp of impSetores) {
  const n = norm(imp.setor);
  if (mapaRamalNorm.has(n)) continue;
  const e = expandir(imp.setor);
  const filhos = setoresRamal.filter((s) => {
    const sn = norm(s.setor);
    return sn !== e && (sn.startsWith(e + ' ') || sn.startsWith(e + ' -'));
  });
  if (filhos.length) filhosPorPrefixo.set(imp.setor, filhos);
}

const paisDetectados = new Set(comPai.map((c) => c.setor));
const umbrellas = [];
for (const [imp, filhos] of filhosPorPrefixo) {
  const adotaveis = filhos.filter((f) => !paisDetectados.has(f.setor));
  if (adotaveis.length >= 2) umbrellas.push({ setor: imp, adota: adotaveis, ignorados: filhos.length - adotaveis.length });
}
const adotados = umbrellas.reduce((a, u) => a + u.adota.length, 0);

console.log(`  guarda-chuvas detectados (2+ filhos): ${umbrellas.length}`);
for (const u of umbrellas) {
  console.log(`    ${u.setor.padEnd(20)} adota ${String(u.adota.length).padStart(2)}` +
    (u.ignorados ? ` (${u.ignorados} ja tinha pai)` : ''));
}
console.log(`  setores de ramal que ganham pai: ${adotados}`);

let exatos = 0, porAbreviacao = 0, novos = 0;
const novosSetores = [];
const adotadosSet = new Set(umbrellas.flatMap((u) => u.adota.map((f) => f.setor)));
for (const imp of impSetores) {
  const n = norm(imp.setor);
  if (mapaRamalNorm.has(n)) { exatos++; continue; }
  const e = expandir(imp.setor);
  const achou = [...mapaRamalNorm.entries()].find(([k]) => k === e);
  if (achou) { porAbreviacao++; continue; }
  if (umbrellas.some((u) => u.setor === imp.setor)) continue; // vira guarda-chuva
  novos++;
  novosSetores.push(imp.setor);
}
console.log(`\n  casam exato com setor de ramal : ${exatos}`);
console.log(`  casam apos expandir abreviacao : ${porAbreviacao}`);
console.log(`  viram guarda-chuva             : ${umbrellas.length}`);
console.log(`  sem correspondencia (raiz nova): ${novos}`);
if (novosSetores.length) console.log(`    ${novosSetores.join(', ')}`);

/* ------------------------------------------------------------------ */
/* 3) Execucao                                                         */
/* ------------------------------------------------------------------ */
if (!APLICAR) {
  console.log('\n=== SIMULACAO ===');
  console.log('  Nada foi gravado. Rode com --aplicar para migrar.');
  fecharConexoes();
  process.exit(0);
}

const jaMigrado = db.prepare('SELECT COUNT(*) c FROM locais').get().c;
if (jaMigrado > 0) {
  console.log(`\nATENCAO: ja existem ${jaMigrado} locais. A migracao nao roda duas vezes.`);
  console.log('  Para refazer, restaure o backup e rode de novo.');
  fecharConexoes();
  process.exit(1);
}

const agora = new Date().toISOString();
const idPorChave = new Map(); // chave logica -> id em locais

db.exec('BEGIN IMMEDIATE');
try {
  const insLocal = db.prepare(`
    INSERT INTO locais (nome, tipo, pai_id, andar, predio, ala, origem, ativo, created_at)
    VALUES (@nome, @tipo, @pai_id, @andar, @predio, @ala, @origem, 1, @criado)
  `);

  // 3a) setores de ramal como raiz
  for (const s of setoresRamal) {
    const r = insLocal.run({
      nome: s.setor,
      tipo: 'setor',
      pai_id: null,
      andar: normalizarAndar(s.andar),
      predio: s.predio || null,
      ala: s.ala || null,
      origem: s.origem || 'planilha',
      criado: agora,
    });
    idPorChave.set(`${norm(s.setor)}|${normalizarAndar(s.andar) ?? -1}`, r.lastInsertRowid);
    idPorChave.set(`ramal:${s.id}`, r.lastInsertRowid);
  }

  // 3b) liga os pais detectados
  let ligados = 0;
  for (const c of comPai) {
    const filho = setoresRamal.find((s) => s.setor === c.setor);
    const pai = setoresRamal.find((s) => s.setor === c.pai);
    if (!filho || !pai) continue;
    const filhoId = idPorChave.get(`ramal:${filho.id}`);
    const paiId = idPorChave.get(`ramal:${pai.id}`);
    if (filhoId && paiId) {
      db.prepare('UPDATE locais SET pai_id = ? WHERE id = ?').run(paiId, filhoId);
      ligados++;
    }
  }
  console.log(`\n=== 3) gravando ===`);
  console.log(`  setores de ramal inseridos: ${setoresRamal.length}`);
  console.log(`  vinculos pai/filho criados: ${ligados}`);

  // 3c) setores de impressora: casar com os de ramal, virar guarda-chuva no
  //     caso dos umbrellas, ou criar raiz nova
  const novoImpSetor = new Map(); // setor impressora -> id em locais
  const idDoNome = new Map();     // nome normalizado -> id (para achar o filho a adotar)

  // primeiro cria os guarda-chuvas, para poder adotar em seguida
  for (const u of umbrellas) {
    const r = insLocal.run({
      nome: u.setor, tipo: 'setor', pai_id: null,
      andar: null, predio: null, ala: null, origem: 'impressora', criado: agora,
    });
    novoImpSetor.set(u.setor, r.lastInsertRowid);
    idDoNome.set(norm(u.setor), r.lastInsertRowid);
  }

  // adota os setores de ramal que ainda estao sem pai
  let adotadosGravados = 0;
  for (const u of umbrellas) {
    const paiId = novoImpSetor.get(u.setor);
    for (const filho of u.adota) {
      const filhoId = idPorChave.get(`ramal:${filho.id}`);
      if (filhoId && paiId) {
        db.prepare('UPDATE locais SET pai_id = ? WHERE id = ?').run(paiId, filhoId);
        adotadosGravados++;
      }
    }
  }

  for (const imp of impSetores) {
    if (novoImpSetor.has(imp.setor)) continue; // ja criado como guarda-chuva
    const n = norm(imp.setor);
    const e = expandir(imp.setor);
    const alvo = mapaRamalNorm.get(n) || [...mapaRamalNorm.entries()].find(([k]) => k === e)?.[1];

    if (alvo) {
      novoImpSetor.set(imp.setor, idPorChave.get(`ramal:${alvo.id}`));
    } else {
      const r = insLocal.run({
        nome: imp.setor, tipo: 'setor', pai_id: null,
        andar: null, predio: null, ala: null, origem: 'impressora', criado: agora,
      });
      novoImpSetor.set(imp.setor, r.lastInsertRowid);
    }
  }

  // 3d) locais de impressora como sublocal do seu setor
  const localDoPar = new Map(); // "setor||local" -> id
  let sublocais = 0;
  for (const par of impLocais) {
    const paiId = novoImpSetor.get(par.setor);
    if (!par.local) { localDoPar.set(`${par.setor}||`, paiId); continue; }

    // o nome do local nao pode repetir sob o mesmo pai: usa o andar da impressora
    const jaTem = db.prepare('SELECT id FROM locais WHERE nome = ? AND IFNULL(pai_id,0) = ?')
      .get(par.local, paiId || 0);
    if (jaTem) { localDoPar.set(`${par.setor}||${par.local}`, jaTem.id); continue; }

    const r = insLocal.run({
      nome: par.local, tipo: 'sublocal', pai_id: paiId,
      andar: null, predio: null, ala: null, origem: 'impressora', criado: agora,
    });
    localDoPar.set(`${par.setor}||${par.local}`, r.lastInsertRowid);
    sublocais++;
  }
  console.log(`  setores de impressora novos: ${novos}`);
  console.log(`  guarda-chuvas criados      : ${umbrellas.length}`);
  console.log(`  setores adotados           : ${adotadosGravados}`);
  console.log(`  sublocais criados          : ${sublocais}`);

  // 3e) vincula impressoras ao seu local
  let impVinculadas = 0;
  for (const imp of db.prepare('SELECT ip, setor, local FROM impressoras WHERE setor IS NOT NULL').all()) {
    const id = localDoPar.get(`${imp.setor}||${imp.local || ''}`) || novoImpSetor.get(imp.setor);
    if (id) {
      db.prepare('UPDATE impressoras SET local_id = ? WHERE ip = ?').run(id, imp.ip);
      impVinculadas++;
    }
  }
  console.log(`  impressoras vinculadas     : ${impVinculadas}`);

  // 3f) migra setor_ramais -> local_ramais
  const links = db.prepare('SELECT setor_id, ramal_curto, ocorrencias, linha_origem FROM setor_ramais').all();
  const insLink = db.prepare(`
    INSERT OR IGNORE INTO local_ramais (local_id, ramal_curto, ocorrencias, linha_origem)
    VALUES (?, ?, ?, ?)
  `);
  let linksOk = 0;
  for (const l of links) {
    const localId = idPorChave.get(`ramal:${l.setor_id}`);
    if (!localId) continue;
    insLink.run(localId, l.ramal_curto, l.ocorrencias, l.linha_origem);
    linksOk++;
  }
  console.log(`  vinculos de ramal migrados : ${linksOk} de ${links.length}`);

  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('\nFALHOU — nada foi gravado:', e.message);
  fecharConexoes();
  process.exit(1);
}

gravarVersaoLocais(db);

/* ------------------------------------------------------------------ */
/* 4) Conferencia                                                      */
/* ------------------------------------------------------------------ */
console.log('\n=== 4) conferencia ===');
const conferir = (rotulo, a, b) => {
  const ok = a === b ? 'OK' : 'DIVERGE';
  console.log(`  ${rotulo.padEnd(34)} ${String(a).padStart(5)} vs ${String(b).padStart(5)}  ${ok}`);
  return a === b;
};
const totalLocais = db.prepare('SELECT COUNT(*) c FROM locais').get().c;
const totalLinksNovo = db.prepare('SELECT COUNT(*) c FROM local_ramais').get().c;
const totalLinksVelho = db.prepare('SELECT COUNT(*) c FROM setor_ramais').get().c;
const impComLocal = db.prepare('SELECT COUNT(*) c FROM impressoras WHERE local_id IS NOT NULL').get().c;

console.log(`  locais criados                : ${totalLocais}`);
conferir('vinculos de ramal preservados', totalLinksNovo, totalLinksVelho);
conferir('impressoras com local', impComLocal, db.prepare('SELECT COUNT(*) c FROM impressoras WHERE setor IS NOT NULL').get().c);

console.log('\n  por tipo/origem:');
for (const r of db.prepare('SELECT tipo, origem, COUNT(*) c FROM locais GROUP BY tipo, origem ORDER BY c DESC').all()) {
  console.log(`    ${String(r.tipo).padEnd(10)} ${String(r.origem).padEnd(12)} ${r.c}`);
}

console.log('\n  arvore (amostra):');
for (const r of db.prepare(`
  WITH RECURSIVE cam(id, trilha, nivel) AS (
    SELECT id, nome, 0 FROM locais WHERE pai_id IS NULL
    UNION ALL SELECT l.id, c.trilha || ' > ' || l.nome, c.nivel+1 FROM locais l JOIN cam c ON l.pai_id = c.id
  ) SELECT * FROM cam WHERE nivel > 0 ORDER BY trilha LIMIT 12`).all()) {
  console.log(`    ${'  '.repeat(r.nivel)}${r.trilha}`);
}

fecharConexoes();
console.log('\nMigracao concluida.');
