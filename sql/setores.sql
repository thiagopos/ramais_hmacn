-- =====================================================================
-- Tabela de setores do hospital (fonte: planilha enviada)
-- ramal_curto = os 4 digitos da planilha (sem o prefixo 40/41)
-- =====================================================================
CREATE TABLE IF NOT EXISTS setores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  setor      TEXT NOT NULL,
  andar      TEXT,
  predio     TEXT,
  ala        TEXT,
  origem     TEXT,               -- 'planilha' | 'manual'
  created_at TEXT NOT NULL
);

-- Um setor pode ter varios ramais e um ramal pode estar em mais de um setor
-- (a planilha tem repetições e sobreposições — por isso nao usamos unicidade).
CREATE TABLE IF NOT EXISTS setor_ramais (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  setor_id     INTEGER NOT NULL REFERENCES setores(id) ON DELETE CASCADE,
  ramal_curto  TEXT NOT NULL,    -- '2064'
  linha_origem INTEGER           -- numero da linha na planilha
);

CREATE INDEX IF NOT EXISTS idx_sr_ramal ON setor_ramais(ramal_curto);
CREATE INDEX IF NOT EXISTS idx_sr_setor ON setor_ramais(setor_id);

-- Relacao resolvida ramal completo <-> setor (gerada pelo vinculo)
CREATE VIEW IF NOT EXISTS v_ramal_setor AS
  SELECT d.ip, d.ramal, d.mac, d.model, d.firmware, d.online, d.missing_since,
         d.last_seen, d.first_seen,
         s.setor, s.andar, s.predio, s.ala,
         substr(d.ramal, 3) AS ramal_curto
  FROM devices d
  LEFT JOIN setor_ramais sr ON sr.ramal_curto = substr(d.ramal, 3)
  LEFT JOIN setores s       ON s.id = sr.setor_id
  WHERE d.is_phone = 1;
