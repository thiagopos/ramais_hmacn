/**
 * Consultas do modulo de impressoras para a interface.
 *
 * A lista le APENAS o estado atual (impressoras + consumiveis), com o pior
 * percentual pre-calculado por subconsulta. O banco antigo fazia JOIN do
 * historico inteiro a cada abertura da tela (577 mil snapshots) e por isso
 * precisava de cache e ainda assim demorava.
 */

/**
 * Lista de impressoras com o resumo de consumiveis.
 *
 * @param {object} db
 * @returns {Array<object>}
 */
export function listarImpressoras(db) {
  const rows = db.prepare(`
    SELECT i.ip, i.serie, i.serie_cadastro, i.modelo, i.descricao, i.apelido,
           i.setor, i.local, i.andar,
           i.ativo, i.online, i.paginas, i.coletado_em, i.faltou_em,
           (SELECT COUNT(*) FROM impressora_consumiveis c WHERE c.ip = i.ip) AS qtd_consumiveis,
           (SELECT MIN(c.percentual) FROM impressora_consumiveis c
             WHERE c.ip = i.ip AND c.percentual IS NOT NULL) AS pior_percentual,
           (SELECT c.nome FROM impressora_consumiveis c
             WHERE c.ip = i.ip AND c.percentual IS NOT NULL
             ORDER BY c.percentual ASC LIMIT 1) AS pior_nome,
           (SELECT COUNT(*) FROM impressora_consumiveis c
             WHERE c.ip = i.ip AND c.percentual IS NOT NULL AND c.percentual < 10) AS criticos
    FROM impressoras i
    ORDER BY CASE WHEN i.online = 1 THEN 0 ELSE 1 END,
             pior_percentual IS NULL, pior_percentual, i.setor, i.ip
  `).all();

  // onde cada serie esta cadastrada, para dizer de qual ponto veio o aparelho
  const porSerie = new Map();
  for (const r of rows) {
    if (r.serie_cadastro) porSerie.set(normalizarSerie(r.serie_cadastro), r.ip);
  }

  return rows.map((r) => {
    const serieLida = normalizarSerie(r.serie);
    const serieCad = normalizarSerie(r.serie_cadastro);
    const trocada = !!(serieLida && serieCad && serieLida !== serieCad);
    // de onde veio a impressora que esta neste IP agora
    const ipOrigem = trocada ? porSerie.get(serieLida) || null : null;
    return {
      ...r,
      nome_exibicao: r.setor || r.apelido || r.ip,
      serie_trocada: trocada ? 1 : 0,
      // a serie que esta aqui agora pertence a outro ponto cadastrado?
      serie_origem_ip: ipOrigem,
      estado: estadoDe(r),
    };
  });
}

/**
 * Normaliza serie para comparar.
 *
 * Alguns firmware devolvem a serie com um ponto final ("ZDEJBQAJ800077Y."),
 * o que geraria divergencia falsa. Tambem removemos espacos.
 */
export function normalizarSerie(s) {
  if (!s) return null;
  return String(s).replace(/[\s.]/g, '').toUpperCase() || null;
}

/**
 * Diz de onde veio a impressora que esta num IP.
 * Compara a serie lida com a serie que o cadastro espera em cada ponto.
 */
export function origemDaSerie(db, serie, ignorarIp = null) {
  const alvo = normalizarSerie(serie);
  if (!alvo) return null;
  const candidatos = db.prepare(
    `SELECT ip, setor, local, serie_cadastro FROM impressoras WHERE serie_cadastro IS NOT NULL`,
  ).all();
  for (const c of candidatos) {
    if (c.ip === ignorarIp) continue;
    if (normalizarSerie(c.serie_cadastro) === alvo) return c;
  }
  return null;
}

/**
 * Classifica o estado de uma impressora.
 * Limiares: critico abaixo de 10%, atencao abaixo de 30%.
 */
export function estadoDe(r) {
  if (r.online !== 1) return 'offline';
  if (r.pior_percentual == null) return 'sem_leitura';
  if (r.pior_percentual < 10) return 'critico';
  if (r.pior_percentual < 30) return 'atencao';
  return 'ok';
}

/** Consumiveis de uma impressora, ordenados do mais critico para o menos. */
export function consumiveisDaImpressora(db, ip) {
  return db.prepare(`
    SELECT slot, nome, nominal, atual, percentual, part_number, serial
    FROM impressora_consumiveis
    WHERE ip = ?
    ORDER BY percentual IS NULL, percentual ASC, slot
  `).all(ip);
}

/** Ficha completa de uma impressora, com consumiveis. */
export function detalheImpressora(db, ip) {
  const i = db.prepare(`SELECT * FROM impressoras WHERE ip = ?`).get(ip);
  if (!i) return null;
  return { ...i, consumiveis: consumiveisDaImpressora(db, ip) };
}

/** Números para os cartões do topo. */
export function resumoImpressoras(db) {
  const base = db.prepare(`
    SELECT
      COUNT(*) total,
      SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) online,
      SUM(CASE WHEN online IS NOT 1 AND coletado_em IS NULL THEN 1 ELSE 0 END) nunca_coletadas
    FROM impressoras WHERE ativo = 1
  `).get();

  // impressora com algum consumivel abaixo dos limiares
  const porEstado = db.prepare(`
    SELECT i.ip,
           (SELECT MIN(c.percentual) FROM impressora_consumiveis c
             WHERE c.ip = i.ip AND c.percentual IS NOT NULL) AS pior
    FROM impressoras i WHERE i.ativo = 1 AND i.online = 1
  `).all();

  let criticas = 0;
  let atencao = 0;
  let semLeitura = 0;
  for (const r of porEstado) {
    if (r.pior == null) semLeitura++;
    else if (r.pior < 10) criticas++;
    else if (r.pior < 30) atencao++;
  }

  const consumiveis = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN percentual IS NOT NULL AND percentual < 10 THEN 1 ELSE 0 END) criticos
    FROM impressora_consumiveis
  `).get();

  const ultima = db.prepare(`SELECT MAX(coletado_em) m FROM impressoras`).get();

  // impressoras cuja serie lida difere da cadastrada (equipamento remanejado)
  const serieCad = db.prepare(
    `SELECT ip, serie, serie_cadastro FROM impressoras WHERE ativo = 1 AND serie IS NOT NULL AND serie_cadastro IS NOT NULL`,
  ).all();
  const trocadas = serieCad.filter((r) => normalizarSerie(r.serie) !== normalizarSerie(r.serie_cadastro)).length;

  return {
    total: base.total || 0,
    online: base.online || 0,
    offline: (base.total || 0) - (base.online || 0),
    criticas,
    atencao,
    trocadas,
    semLeitura,
    consumiveis: consumiveis.total || 0,
    consumiveisCriticos: consumiveis.criticos || 0,
    ultimaColeta: ultima?.m || null,
  };
}

/** Lista de setores distintos (para o filtro). */
export function setoresDasImpressoras(db) {
  return db.prepare(`
    SELECT setor, andar, COUNT(*) qtd
    FROM impressoras WHERE setor IS NOT NULL AND ativo = 1
    GROUP BY setor, andar ORDER BY setor
  `).all();
}

/** Todos os consumiveis com o pior nível primeiro (visao de insumos). */
export function listarConsumiveis(db, { limite = 300 } = {}) {
  return db.prepare(`
    SELECT c.ip, c.nome, c.percentual, c.part_number, c.serial, c.nominal, c.atual,
           i.setor, i.modelo, i.online
    FROM impressora_consumiveis c
    JOIN impressoras i ON i.ip = c.ip
    ORDER BY c.percentual IS NULL, c.percentual ASC, i.setor
    LIMIT ?
  `).all(limite);
}
