-- =====================================================================
-- Setores do hospital e sua relacao com os ramais.
--
-- REGRA: um ramal pode pertencer a VARIOS setores ao mesmo tempo.
-- Nao existe "ramal principal" — todas as linhas da planilha valem.
-- Linhas 100% identicas (mesmo ramal + setor + andar + ala) sao
-- consolidadas num unico vinculo, guardando quantas vezes apareceram.
-- =====================================================================

-- cada linha distinta da planilha vira um setor
CREATE TABLE IF NOT EXISTS setores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  setor      TEXT NOT NULL,
  andar      TEXT,
  predio     TEXT,
  ala        TEXT,
  origem     TEXT,               -- 'planilha' | 'manual'
  created_at TEXT NOT NULL
);

-- relacao ramal <-> setor (N:N). A chave unica evita vinculo duplicado.
CREATE TABLE IF NOT EXISTS setor_ramais (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  setor_id     INTEGER NOT NULL REFERENCES setores(id) ON DELETE CASCADE,
  ramal_curto  TEXT NOT NULL,    -- '2064' (4 digitos, sem prefixo 40/41)
  ocorrencias  INTEGER NOT NULL DEFAULT 1,  -- quantas linhas iguais na planilha
  linha_origem INTEGER,          -- 1a linha da planilha onde apareceu
  UNIQUE (setor_id, ramal_curto)
);

CREATE INDEX IF NOT EXISTS idx_sr_ramal ON setor_ramais(ramal_curto);
CREATE INDEX IF NOT EXISTS idx_sr_setor ON setor_ramais(setor_id);

-- ---------------------------------------------------------------------
-- Uma linha por (telefone x setor): o ramal se repete para cada setor.
-- Telefone sem setor na planilha aparece uma vez, com setor nulo.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_ramal_setor;
CREATE VIEW v_ramal_setor AS
  SELECT
    d.ip, d.ramal, d.mac, d.model, d.firmware,
    d.online, d.missing_since, d.last_seen, d.first_seen,
    s.setor, s.andar, s.predio, s.ala,
    sr.ocorrencias,
    substr(d.ramal, 3) AS ramal_curto
  FROM devices d
  LEFT JOIN setor_ramais sr ON sr.ramal_curto = substr(d.ramal, 3)
  LEFT JOIN setores s       ON s.id = sr.setor_id
  WHERE d.is_phone = 1;

-- ---------------------------------------------------------------------
-- Uma linha por telefone, com TODOS os setores concatenados.
-- Util para listagens e para o painel web.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_device_setores;
CREATE VIEW v_device_setores AS
  SELECT
    d.ip, d.ramal, d.mac, d.model, d.firmware, d.online, d.missing_since,
    d.last_seen, d.first_seen,
    COUNT(sr.id)                                        AS qtd_setores,
    GROUP_CONCAT(s.setor, ' | ')                        AS setores,
    GROUP_CONCAT(IFNULL(s.andar, ''), ' | ')            AS andares,
    GROUP_CONCAT(IFNULL(s.ala, ''), ' | ')              AS alas,
    GROUP_CONCAT(IFNULL(s.predio, ''), ' | ')           AS predios
  FROM devices d
  LEFT JOIN setor_ramais sr ON sr.ramal_curto = substr(d.ramal, 3)
  LEFT JOIN setores s       ON s.id = sr.setor_id
  WHERE d.is_phone = 1
  GROUP BY d.ip;
