-- =====================================================================
-- Indicadores de estabilidade por telefone, calculados sobre o historico
-- de amostras (1 ciclo por hora).
--
-- metrica      : pct de ciclos na janela em que o aparelho NAO respondeu
-- quedas       : quantas vezes caiu (transicao online -> offline)
-- em_queda     : esta fora agora (ultima amostra offline)
-- em_instabilidade: respondeu bem antes, mas ja caiu >= 1 vez
--                   (distingue equipamento intermitente de um que nunca
--                   subiu — ex.: aparelho novo no dia 1)
-- =====================================================================
DROP VIEW IF EXISTS v_estabilidade;
CREATE VIEW v_estabilidade AS
WITH ultimo AS (
  SELECT ip, MAX(id) AS ultimo_id
  FROM monitor_samples
  GROUP BY ip
),
base AS (
  SELECT
    s.ip,
    COUNT(*)                                                   AS amostras,
    SUM(CASE WHEN s.online = 0 THEN 1 ELSE 0 END)              AS amostras_offline,
    SUM(CASE WHEN s.online = 1 THEN 1 ELSE 0 END)              AS amostras_online,
    MIN(CASE WHEN s.online = 0 THEN s.created_at END)          AS primeira_falha,
    MAX(CASE WHEN s.online = 0 THEN s.created_at END)          AS ultima_falha,
    MIN(s.created_at)                                          AS primeira_amostra
  FROM monitor_samples s
  GROUP BY s.ip
),
q_ord AS (
  SELECT s.ip, s.online,
         LAG(s.online) OVER (PARTITION BY s.ip ORDER BY s.created_at) AS anterior
  FROM monitor_samples s
),
q AS (
  SELECT ip,
         SUM(CASE WHEN online = 0 AND (anterior IS NULL OR anterior = 1) THEN 1 ELSE 0 END) AS quedas
  FROM q_ord
  GROUP BY ip
)
SELECT
  b.ip,
  d.ramal,
  b.amostras,
  b.amostras_offline,
  b.amostras_online,
  CASE WHEN b.amostras > 0
       THEN ROUND(100.0 * b.amostras_offline / b.amostras, 1) END AS pct_indisponivel,
  q.quedas,
  CASE WHEN ms.online = 0 THEN 1 ELSE 0 END                    AS em_queda,
  CASE WHEN b.amostras_online >= 2 AND q.quedas >= 1
       THEN 1 ELSE 0 END                                       AS em_instabilidade,
  b.primeira_falha,
  b.ultima_falha,
  b.primeira_amostra
FROM base b
JOIN ultimo u          ON u.ip = b.ip
JOIN monitor_samples ms ON ms.id = u.ultimo_id
JOIN q                 ON q.ip = b.ip
LEFT JOIN devices d    ON d.ip = b.ip;
