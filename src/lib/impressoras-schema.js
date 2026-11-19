/**
 * Schema do modulo de impressoras.
 *
 * DESENHO: guarda o ESTADO ATUAL, nao o historico de cada coleta.
 * O banco antigo (printers-snmp) tinha 577 mil snapshots e 880 mil linhas
 * de consumivel — 149 MB — porque gravava tudo a cada 30 minutos e nunca
 * apagava. Aqui a lista precisa de 103 linhas, nao de 880 mil.
 *
 * O historico (para tendencia de consumo) e uma tabela separada e opcional,
 * com retencao propria, para nao contaminar o caminho da listagem.
 *
 * Nada aqui depende de maquina, IP fixo ou lista de modelo: o nome do
 * consumivel vem da propria impressora (padrao MIB-II 43.11.1.1).
 */

/** Versao do schema do modulo (independente do schema principal). */
export const PRINTERS_SCHEMA_VERSION = 1;

export function criarTabelasImpressoras(db) {
  db.exec(`
    -- Uma linha por impressora monitorada. O IP e o identificador de rede;
    -- a serie e a identidade fisica (sobrevive a troca de IP por DHCP).
    CREATE TABLE IF NOT EXISTS impressoras (
      ip            TEXT PRIMARY KEY,
      serie         TEXT,     -- serie que a IMPRESSORA reporta agora (SNMP)
      serie_cadastro TEXT,    -- serie que o cadastro espera naquele IP
      modelo        TEXT,
      descricao     TEXT,     -- sysDescr cru, util para diagnostico
      apelido       TEXT,     -- nome dado por nos / pelo painel do aparelho
      setor         TEXT,     -- setor guarda-chuva (ex.: AMBULATÓRIO)
      local         TEXT,     -- local dentro do setor (ex.: Egressos Sala 1)
      andar         TEXT,
      ativo         INTEGER NOT NULL DEFAULT 1,
      -- estado da ultima coleta bem-sucedida
      online        INTEGER,
      paginas       INTEGER,  -- contador total de impressao
      coletado_em   TEXT,
      faltou_em     TEXT,     -- ultima coleta em que NAO respondeu
      criado_em     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_impressoras_serie ON impressoras(serie);
    CREATE INDEX IF NOT EXISTS idx_impressoras_setor ON impressoras(setor);

    -- Consumiveis do ULTIMO estado conhecido (substituidos a cada coleta).
    -- Nome vem da impressora: nao existe lista fixa por modelo.
    CREATE TABLE IF NOT EXISTS impressora_consumiveis (
      ip             TEXT NOT NULL,
      slot           INTEGER NOT NULL,   -- indice na tabela MIB da impressora
      nome           TEXT NOT NULL,
      nominal        INTEGER,            -- capacidade declarada
      atual          INTEGER,            -- nivel medido (unidades ou %)
      percentual     INTEGER,            -- calculado quando possivel
      part_number    TEXT,               -- extraido do nome ou de OID especifico
      serial         TEXT,               -- serial do cartucho, quando informado
      paginas_restantes INTEGER,
      PRIMARY KEY (ip, slot)
    );

    -- Historico enxuto para tendencia: UMA linha por impressora por dia
    -- (nao por coleta). Retencao curta, mantida pelo modulo.
    CREATE TABLE IF NOT EXISTS impressora_historico (
      ip          TEXT NOT NULL,
      dia         TEXT NOT NULL,   -- AAAA-MM-DD
      paginas     INTEGER,
      consumiveis TEXT,            -- JSON compacto {slot: percentual}
      PRIMARY KEY (ip, dia)
    );
    CREATE INDEX IF NOT EXISTS idx_hist_dia ON impressora_historico(dia);
  `);

  // acrescenta colunas novas em bancos que ja existiam
  migrarColunas(db);
}

/** Grava/atualiza a versao do modulo na tabela meta. */
export function gravarVersaoImpressoras(db, versao = PRINTERS_SCHEMA_VERSION) {
  db.prepare(`INSERT INTO meta (key, value) VALUES ('printers_schema_version', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(versao));
}

/**
 * Migracoes aditivas para bancos ja existentes.
 * CREATE TABLE IF NOT EXISTS nao acrescenta coluna nova a tabela existente,
 * entao cada coluna nova precisa ser verificada aqui.
 */
function migrarColunas(db) {
  const atuais = db.prepare('PRAGMA table_info(impressoras)').all().map((c) => c.name);
  const adicionar = (nome, tipo) => {
    if (!atuais.includes(nome)) db.exec(`ALTER TABLE impressoras ADD COLUMN ${nome} ${tipo}`);
  };
  adicionar('local', 'TEXT');
  adicionar('serie_cadastro', 'TEXT');
}

export function lerVersaoImpressoras(db) {
  try {
    const r = db.prepare(`SELECT value FROM meta WHERE key = 'printers_schema_version'`).get();
    return r ? Number(r.value) : 0;
  } catch {
    return 0;
  }
}
