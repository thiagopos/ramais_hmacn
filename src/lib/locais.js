/**
 * Locais: setores, sublocais e o "guarda-chuva" (pai).
 *
 * UM LUGAR = UMA LINHA. Ramais e impressoras apontam para o mesmo registro,
 * em vez de cada um ter o seu vocabulario de texto livre.
 *
 * REGRAS DE EXCLUSAO (definidas pelo uso real do hospital):
 *  - excluir um pai NAO apaga os filhos: eles perdem o vinculo e viram raiz
 *    (pai_id -> NULL). Um setor pode existir sem pai, sempre.
 *  - excluir um local NAO apaga quem estava nele: impressoras ficam com
 *    local_id NULL ("livres") e os ramais perdem so o vinculo — o ramal
 *    continua existindo em devices.
 *  - pai_id e OPCIONAL: a hierarquia organiza, nao condiciona o cadastro.
 *
 * UNICIDADE: nome + pai + andar. Nomes se repetem de proposito em andares
 * diferentes ("Coordenacao de Enfermagem" no 4o e no 5o andar sao lugares
 * distintos), entao o nome sozinho nunca pode ser chave.
 */

export const LOCAIS_SCHEMA_VERSION = 1;

export function criarTabelasLocais(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locais (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      nome          TEXT    NOT NULL,
      tipo          TEXT    NOT NULL DEFAULT 'setor',   -- 'setor' | 'sublocal'
      pai_id        INTEGER REFERENCES locais(id) ON DELETE SET NULL,
      andar         INTEGER,       -- 0 = Terreo
      predio        TEXT,          -- 'Hospitalar' | 'Administrativo'
      ala           TEXT,
      origem        TEXT,          -- planilha | intranet | impressora | manual
      ativo         INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL,
      atualizado_em TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_locais_pai  ON locais(pai_id);
    CREATE INDEX IF NOT EXISTS idx_locais_nome ON locais(nome);
    CREATE INDEX IF NOT EXISTS idx_locais_andar ON locais(andar);

    -- Um nome pode repetir em andares diferentes, mas nao no mesmo pai+andar.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_locais_unico
      ON locais(nome, IFNULL(pai_id, 0), IFNULL(andar, -1));

    -- Vinculo ramal <-> local (N:N, como ja era em setor_ramais).
    -- O ramal vive em devices; esta tabela guarda so o vinculo. Excluir o
    -- local apaga os vinculos, nunca os ramais.
    CREATE TABLE IF NOT EXISTS local_ramais (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      local_id     INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE,
      ramal_curto  TEXT    NOT NULL,
      ocorrencias  INTEGER NOT NULL DEFAULT 1,
      linha_origem INTEGER,
      UNIQUE (local_id, ramal_curto)
    );
    CREATE INDEX IF NOT EXISTS idx_local_ramais_local ON local_ramais(local_id);
    CREATE INDEX IF NOT EXISTS idx_local_ramais_ramal ON local_ramais(ramal_curto);
  `);

  // impressoras ganham o vinculo com locais (coluna nova em banco existente)
  const colsImp = db.prepare('PRAGMA table_info(impressoras)').all().map((c) => c.name);
  if (!colsImp.includes('local_id')) {
    // ON DELETE SET NULL: excluir o local deixa a impressora "livre", nao apaga
    db.exec('ALTER TABLE impressoras ADD COLUMN local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_impressoras_local ON impressoras(local_id)');
  }
}

export function gravarVersaoLocais(db, versao = LOCAIS_SCHEMA_VERSION) {
  db.prepare(`INSERT INTO meta (key, value) VALUES ('locais_schema_version', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(versao));
}

export function lerVersaoLocais(db) {
  try {
    const r = db.prepare(`SELECT value FROM meta WHERE key = 'locais_schema_version'`).get();
    return r ? Number(r.value) : 0;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Leitura                                                             */
/* ------------------------------------------------------------------ */

/**
 * Arvore completa: cada local com o caminho ate a raiz.
 * Usa CTE recursiva para resolver qualquer profundidade.
 */
export function arvoreLocais(db) {
  return db.prepare(`
    WITH RECURSIVE caminho(id, raiz, nivel, trilha) AS (
      SELECT id, id, 0, nome FROM locais WHERE pai_id IS NULL
      UNION ALL
      SELECT l.id, c.raiz, c.nivel + 1, c.trilha || ' › ' || l.nome
        FROM locais l JOIN caminho c ON l.pai_id = c.id
    )
    SELECT lo.*, c.nivel, c.trilha,
           p.nome AS pai_nome,
           (SELECT COUNT(*) FROM locais f WHERE f.pai_id = lo.id) AS filhos,
           (SELECT COUNT(*) FROM local_ramais r WHERE r.local_id = lo.id) AS ramais,
           (SELECT COUNT(*) FROM impressoras i WHERE i.local_id = lo.id) AS impressoras
    FROM locais lo
    LEFT JOIN caminho c ON c.id = lo.id
    LEFT JOIN locais p ON p.id = lo.pai_id
    ORDER BY IFNULL(c.trilha, lo.nome) COLLATE NOCASE
  `).all();
}

/** Lista simples (para seletores), com o caminho para desambiguar nomes iguais. */
export function listarLocais(db, { apenasAtivos = true } = {}) {
  return db.prepare(`
    WITH RECURSIVE caminho(id, trilha, nivel) AS (
      SELECT id, nome, 0 FROM locais WHERE pai_id IS NULL
      UNION ALL
      SELECT l.id, c.trilha || ' › ' || l.nome, c.nivel + 1
        FROM locais l JOIN caminho c ON l.pai_id = c.id
    )
    SELECT lo.id, lo.nome, lo.tipo, lo.pai_id, lo.andar, lo.predio, lo.ala,
           lo.origem, lo.ativo, lo.created_at,
           IFNULL(c.trilha, lo.nome) AS caminho,
           IFNULL(c.nivel, 0) AS nivel,
           (SELECT COUNT(*) FROM local_ramais r WHERE r.local_id = lo.id) AS ramais,
           (SELECT COUNT(*) FROM impressoras i WHERE i.local_id = lo.id) AS impressoras
    FROM locais lo
    LEFT JOIN caminho c ON c.id = lo.id
    ${apenasAtivos ? 'WHERE lo.ativo = 1' : ''}
    ORDER BY caminho COLLATE NOCASE
  `).all();
}

/** Um local pelo id, com contagens. */
export function obterLocal(db, id) {
  return db.prepare(`
    SELECT lo.*, p.nome AS pai_nome,
           (SELECT COUNT(*) FROM local_ramais r WHERE r.local_id = lo.id) AS ramais,
           (SELECT COUNT(*) FROM impressoras i WHERE i.local_id = lo.id) AS impressoras,
           (SELECT COUNT(*) FROM locais f WHERE f.pai_id = lo.id) AS filhos
    FROM locais lo LEFT JOIN locais p ON p.id = lo.pai_id
    WHERE lo.id = ?
  `).get(Number(id)) || null;
}

/** Todos os descendentes de um local (para somar totais do guarda-chuva). */
export function descendentes(db, id) {
  return db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM locais WHERE pai_id = ?
      UNION ALL
      SELECT l.id FROM locais l JOIN sub s ON l.pai_id = s.id
    )
    SELECT id FROM sub
  `).all(Number(id)).map((r) => r.id);
}

/** Ramais vinculados a um local. */
export function ramaisDoLocal(db, localId) {
  return db.prepare(`
    SELECT r.ramal_curto, r.ocorrencias, r.linha_origem,
           d.ramal AS ramal_completo, d.ip, d.model, d.online
    FROM local_ramais r
    LEFT JOIN devices d ON substr(d.ramal, 3) = r.ramal_curto
    WHERE r.local_id = ?
    ORDER BY CAST(r.ramal_curto AS INTEGER)
  `).all(Number(localId));
}

/** Impressoras vinculadas a um local. */
export function impressorasDoLocal(db, localId) {
  return db.prepare(`
    SELECT ip, serie, modelo, apelido, online, paginas, coletado_em
    FROM impressoras WHERE local_id = ?
    ORDER BY ip
  `).all(Number(localId));
}

/* ------------------------------------------------------------------ */
/* Escrita                                                             */
/* ------------------------------------------------------------------ */

/** Normaliza andar aceitando "Térreo", "1º Andar", "1" ou 1. */
export function normalizarAndar(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const t = String(valor).trim().toLowerCase();
  if (!t) return null;
  if (/t[eé]rreo|terreo|^0$/.test(t)) return 0;
  const m = t.match(/\d+/);
  return m ? Number(m[0]) : null;
}

/** "0" -> "Térreo", "1" -> "1º Andar" (o que a interface mostra). */
export function rotuloAndar(andar) {
  if (andar === null || andar === undefined) return '—';
  const n = Number(andar);
  if (n === 0) return 'Térreo';
  return `${n}º Andar`;
}

function agora() {
  return new Date().toISOString();
}

/**
 * Cria um local. `pai_id` e opcional.
 * Recusa criar duplicata exata (mesmo nome, pai e andar).
 */
export function criarLocal(db, { nome, tipo = 'setor', paiId = null, andar = null, predio = null, ala = null, origem = 'manual' }) {
  const n = String(nome || '').trim();
  if (!n) return { ok: false, erro: 'o nome do setor é obrigatório' };

  const andarNum = normalizarAndar(andar);
  const pai = paiId ? Number(paiId) : null;

  if (pai) {
    const existe = db.prepare('SELECT id FROM locais WHERE id = ?').get(pai);
    if (!existe) return { ok: false, erro: 'o setor pai informado não existe' };
  }

  const dup = db.prepare(`
    SELECT id FROM locais
    WHERE nome = ? AND IFNULL(pai_id, 0) = IFNULL(?, 0) AND IFNULL(andar, -1) = IFNULL(?, -1)
  `).get(n, pai, andarNum);
  if (dup) return { ok: false, erro: `já existe um local com este nome${andarNum !== null ? ' neste andar' : ''}` };

  const r = db.prepare(`
    INSERT INTO locais (nome, tipo, pai_id, andar, predio, ala, origem, ativo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(n, tipo, pai, andarNum, predio || null, ala || null, origem, agora());

  return { ok: true, id: r.lastInsertRowid };
}

/**
 * Edita um local. Campos ausentes ficam como estao.
 * Mudar o pai e permitido; mover um local para dentro de um descendente dele
 * mesmo criaria um ciclo, entao isso e bloqueado.
 */
export function editarLocal(db, id, { nome, tipo, paiId, andar, predio, ala, ativo }) {
  const atual = obterLocal(db, id);
  if (!atual) return { ok: false, erro: 'local não encontrado' };

  const n = nome !== undefined ? String(nome || '').trim() : atual.nome;
  if (!n) return { ok: false, erro: 'o nome do setor é obrigatório' };

  const pai = paiId !== undefined ? (paiId ? Number(paiId) : null) : atual.pai_id;
  const andarNum = andar !== undefined ? normalizarAndar(andar) : atual.andar;

  if (pai) {
    if (pai === atual.id) return { ok: false, erro: 'um local não pode ser pai de si mesmo' };
    const paiExiste = db.prepare('SELECT id FROM locais WHERE id = ?').get(pai);
    if (!paiExiste) return { ok: false, erro: 'o setor pai informado não existe' };
    // impede ciclo: o novo pai nao pode estar entre os descendentes deste local
    const subs = descendentes(db, atual.id);
    if (subs.includes(pai)) return { ok: false, erro: 'o setor pai escolhido é descendente deste local (criaria um ciclo)' };
  }

  const dup = db.prepare(`
    SELECT id FROM locais
    WHERE nome = ? AND IFNULL(pai_id, 0) = IFNULL(?, 0) AND IFNULL(andar, -1) = IFNULL(?, -1) AND id <> ?
  `).get(n, pai, andarNum, atual.id);
  if (dup) return { ok: false, erro: 'já existe outro local com este nome neste pai/andar' };

  const tipoFinal = tipo !== undefined ? tipo : atual.tipo;
  const ativoFinal = ativo !== undefined ? (ativo ? 1 : 0) : atual.ativo;

  db.prepare(`
    UPDATE locais SET nome = ?, tipo = ?, pai_id = ?, andar = ?, predio = ?, ala = ?, ativo = ?, atualizado_em = ?
    WHERE id = ?
  `).run(
    n, tipoFinal, pai, andarNum,
    predio !== undefined ? (predio || null) : atual.predio,
    ala !== undefined ? (ala || null) : atual.ala,
    ativoFinal, agora(), atual.id,
  );

  return { ok: true };
}

/**
 * Exclui um local.
 *
 * O que acontece com o que estava nele — por decisao de projeto:
 *  - os FILHOS nao sao apagados: perdem o pai e viram raiz (ON DELETE SET NULL)
 *  - as IMPRESSORAS ficam livres, com local_id NULL (ON DELETE SET NULL)
 *  - os RAMAIS perdem apenas o vinculo; o ramal continua em devices
 *
 * @returns {{ok:boolean, erro?:string, soltos?:object}}
 */
export function excluirLocal(db, id) {
  const atual = obterLocal(db, id);
  if (!atual) return { ok: false, erro: 'local não encontrado' };

  const filhos = db.prepare('SELECT COUNT(*) c FROM locais WHERE pai_id = ?').get(atual.id).c;
  const impressoras = db.prepare('SELECT COUNT(*) c FROM impressoras WHERE local_id = ?').get(atual.id).c;
  const ramais = db.prepare('SELECT COUNT(*) c FROM local_ramais WHERE local_id = ?').get(atual.id).c;

  db.exec('BEGIN IMMEDIATE');
  try {
    // registra o que sera solto, para a interface poder avisar
    db.prepare(`INSERT INTO events (scan_id, ip, event, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(db.prepare('SELECT IFNULL(MAX(id),0) m FROM scans').get().m, '*', 'local_excluido',
        `"${atual.nome}": ${filhos} filho(s) solto(s), ${impressoras} impressora(s) livre(s), ${ramais} ramal(is) desvinculado(s)`,
        agora());

    db.prepare('DELETE FROM local_ramais WHERE local_id = ?').run(atual.id);
    db.prepare('DELETE FROM locais WHERE id = ?').run(atual.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, erro: e.message };
  }

  return { ok: true, soltos: { filhos, impressoras, ramais } };
}

/** Vincula um ramal (curto, 4 digitos) a um local. */
export function vincularRamal(db, { localId, ramalCurto }) {
  const id = Number(localId);
  const curto = String(ramalCurto || '').replace(/\D/g, '').slice(-4);
  if (!id || !curto) return { ok: false, erro: 'local e ramal são obrigatórios' };
  if (!db.prepare('SELECT id FROM locais WHERE id = ?').get(id)) return { ok: false, erro: 'local não encontrado' };

  const dup = db.prepare('SELECT id FROM local_ramais WHERE local_id = ? AND ramal_curto = ?').get(id, curto);
  if (dup) return { ok: false, erro: 'este ramal já está neste local' };

  db.prepare('INSERT INTO local_ramais (local_id, ramal_curto, ocorrencias, linha_origem) VALUES (?, ?, 1, NULL)')
    .run(id, curto);
  return { ok: true };
}

export function desvincularRamal(db, { localId, ramalCurto }) {
  const r = db.prepare('DELETE FROM local_ramais WHERE local_id = ? AND ramal_curto = ?')
    .run(Number(localId), String(ramalCurto || '').replace(/\D/g, '').slice(-4));
  return r.changes ? { ok: true } : { ok: false, erro: 'vínculo não encontrado' };
}

/** Move uma impressora para um local (ou deixa livre, com localId null). */
export function moverImpressora(db, { ip, localId }) {
  const existe = db.prepare('SELECT ip FROM impressoras WHERE ip = ?').get(ip);
  if (!existe) return { ok: false, erro: 'impressora não encontrada' };
  const id = localId ? Number(localId) : null;
  if (id && !db.prepare('SELECT id FROM locais WHERE id = ?').get(id)) {
    return { ok: false, erro: 'local não encontrado' };
  }
  db.prepare('UPDATE impressoras SET local_id = ? WHERE ip = ?').run(id, ip);
  return { ok: true };
}
