-- =====================================================================
-- Historico de quedas agrupado em EPISODIOS.
--
-- Cada episodio = sequencia continua de coletas sem resposta.
-- inicio  = horario da primeira coleta offline
-- retorno = horario da coleta que voltou a responder (NULL = ainda offline)
-- duracao_min = minutos entre inicio e retorno
--
-- Assim, 10 horas seguidas offline viram UMA linha, nao 40.
-- =====================================================================
DROP VIEW IF EXISTS v_quedas;
CREATE VIEW v_quedas AS
WITH passo AS (
  SELECT
    s.ip,
    s.created_at,
    s.online,
    LAG(s.online) OVER (PARTITION BY s.ip ORDER BY s.created_at) AS anterior
  FROM monitor_samples s
),
marcado AS (
  SELECT ip, created_at, online,
         -- abre novo episodio quando cai (offline vindo de online/desconhecido)
         CASE WHEN online = 0 AND (anterior IS NULL OR anterior = 1) THEN 1 ELSE 0 END AS abre,
         anterior
  FROM passo
),
numerado AS (
  SELECT ip, created_at, online, abre,
         SUM(abre) OVER (PARTITION BY ip ORDER BY created_at
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ep
  FROM marcado
)
SELECT
  n.ip,
  d.ramal,
  n.ep,
  MIN(CASE WHEN n.online = 0 THEN n.created_at END)          AS inicio,
  MIN(CASE WHEN n.online = 1 THEN n.created_at END)          AS retorno,
  SUM(CASE WHEN n.online = 0 THEN 1 ELSE 0 END)              AS coletas_offline,
  CASE
    WHEN MIN(CASE WHEN n.online = 1 THEN n.created_at END) IS NULL THEN NULL
    ELSE CAST(ROUND((julianday(MIN(CASE WHEN n.online = 1 THEN n.created_at END))
                   - julianday(MIN(CASE WHEN n.online = 0 THEN n.created_at END))) * 24 * 60) AS INTEGER)
  END                                                        AS duracao_min
FROM numerado n
LEFT JOIN devices d ON d.ip = n.ip
GROUP BY n.ip, n.ep
HAVING SUM(CASE WHEN n.online = 0 THEN 1 ELSE 0 END) > 0
ORDER BY inicio DESC;
