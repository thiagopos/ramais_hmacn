/**
 * Leitura SNMP de impressoras.
 *
 * Usa os OIDs padrao da MIB-II Printer (1.3.6.1.2.1.43) — o mesmo que
 * qualquer impressora de rede expoe. NAO existe lista de consumiveis por
 * modelo: o nome vem da propria impressora. O codigo antigo mantinha
 * arrays fixos por modelo (NOMES_SAMSUNG, NOMES_HP...) e ficava cego para
 * qualquer aparelho fora da lista.
 *
 * ARMADILHAS DO net-snmp encontradas em teste real:
 *  - subtree() dispara "req.doneCb is not a function" e DERRUBA o processo
 *    quando usado mais de uma vez na mesma sessao. Aqui nao usamos walk.
 *  - um get com muitos OIDs estoura o tamanho do datagrama e a impressora
 *    simplesmente nao responde (parece offline). As HP tem nomes longos
 *    ("Revelador Ciano HP Z7Y69A"), entao lemos UM consumivel por requisicao.
 */
import snmp from 'net-snmp';

const MIB_PRINTER = '1.3.6.1.2.1.43';
const OID_SYSDESCR = '1.3.6.1.2.1.1.1.0';
const OID_SERIAL = `${MIB_PRINTER}.5.1.1.17.1`;
const OID_MODELO = `${MIB_PRINTER}.5.1.1.16.1`;   // prtGeneralModelName
const OID_PAGINAS = `${MIB_PRINTER}.10.2.1.4.1.1`;
const AN = `${MIB_PRINTER}.11.1.1`;
const OID_DESC = `${AN}.6`;
const OID_CAPACIDADE = `${AN}.8`;
const OID_NIVEL = `${AN}.9`;

/** Quantos slots de consumivel tentar (as A3 chegam a 12). */
const MAX_SLOTS = 12;

/**
 * Part number no nome do consumivel.
 *
 * As HP escrevem "Preto HP W9008MC" ou "Kit do fusor HP 110V-B5L35A, 220V-B5L36A".
 * O padrao cobre as duas formas: letras + digitos + sufixo opcional, e o
 * segundo codigo depois da virgula (caso dos kits com voltagem).
 */
const RE_PN = /\b([A-Z]{1,3}\d{3,4}[A-Z]{0,3}(?:-[A-Z0-9]+)?)\b/;
const RE_PN2 = /\b([A-Z]{1,3}\d{3,4}[A-Z]{0,3})\b/g;
/** Serie embutida no nome (Samsung/HP informam "S/N:XXXX"). */
const RE_SERIAL = /S\/N:\s*([A-Za-z0-9-]+)/i;

/**
 * Uma consulta get. Resolve com os varbinds ou null em erro/timeout.
 * Sempre fecha a sessao: sessoes abertas seguram o processo no fim.
 */
function getUma(ip, oids, { comunidade, timeoutMs }) {
  return new Promise((resolve) => {
    let terminou = false;
    const fim = (r) => { if (terminou) return; terminou = true; clearTimeout(timer); try { sessao.close(); } catch { /* ja fechada */ } resolve(r); };

    const sessao = snmp.createSession(ip, comunidade, {
      timeout: timeoutMs,
      retries: 1,
      version: snmp.Version1,
    });
    sessao.on('error', () => fim(null));

    const timer = setTimeout(() => fim(null), timeoutMs + 1500);
    sessao.get(oids, (err, varbinds) => {
      if (err) return fim(null);
      fim(varbinds);
    });
  });
}

/** Valor de um varbind, ou null se ausente/erro. */
function valor(vb) {
  if (!vb || snmp.isVarbindError(vb)) return null;
  return vb.value;
}

/** Texto limpo: a MIB costuma devolver NUL no fim da string. */
function texto(v) {
  if (v == null) return null;
  const t = String(v).replace(/\0/g, '').trim();
  return t || null;
}

/**
 * Normaliza um consumivel.
 *
 * Dois formatos aparecem na pratica:
 *  - impressoras mono reportam nivel REAL (ex.: 3450 de 15000 unidades)
 *  - as coloridas reportam nivel em PORCENTAGEM (0..100) com capacidade 100
 * Calculamos o percentual a partir do que vier; niveis negativos (-2) sao
 * o "indisponivel" da MIB e nao viram numero.
 */
export function normalizarConsumivel({ slot, nome, capacidade, nivel }) {
  const n = texto(nome);
  if (!n) return null;

  const cap = Number(capacidade);
  const nv = Number(nivel);
  const capValida = Number.isFinite(cap) && cap > 0;
  const nivelValido = Number.isFinite(nv) && nv >= 0;

  let percentual = null;
  if (nivelValido && capValida) percentual = Math.round((nv / cap) * 100);
  // algumas HP devolvem a porcentagem direto, com capacidade 100
  if (nivelValido && cap === 100) percentual = Math.round(nv);
  if (percentual != null) percentual = Math.max(0, Math.min(100, percentual));

  const pn = (n.match(RE_PN) || [])[1] || null;
  // kits com duas voltagens: "110V-B5L35A, 220V-B5L36A" -> pega o codigo puro
  let pn2 = null;
  if (!pn) {
    const achados = [...n.matchAll(RE_PN2)].map((m) => m[1]);
    pn2 = achados.length ? achados[achados.length - 1] : null;
  }
  const serial = (n.match(RE_SERIAL) || [])[1] || null;

  return {
    slot,
    nome: n.replace(/\s*S\/N:\s*[A-Za-z0-9-]+/i, '').trim(),
    nominal: capValida ? cap : null,
    atual: nivelValido ? nv : null,
    percentual,
    part_number: pn || pn2,
    serial,
  };
}

/**
 * Le identidade e consumiveis de uma impressora.
 *
 * @param {string} ip
 * @param {{comunidade?: string, timeoutMs?: number}} opcoes
 * @returns {Promise<object|null>} null quando a impressora nao respondeu
 */
export async function lerImpressora(ip, { comunidade = 'public', timeoutMs = 3000 } = {}) {
  const cfg = { comunidade, timeoutMs };

  // 1) identidade: descricao, serie e contador de paginas (um get)
  const ident = await getUma(ip, [OID_SYSDESCR, OID_SERIAL, OID_PAGINAS], cfg);
  if (!ident) return null;

  const descricao = texto(valor(ident[0]));
  const serie = texto(valor(ident[1]));
  const paginas = valor(ident[2]);
  if (!descricao && !serie) return null; // respondeu lixo: nao e impressora

  // 2) modelo: sysDescr das HP e generico ("ETHERNET MULTI-ENVIRONMENT..."),
  //    o prtGeneralModelName traz o nome comercial ("HP LaserJet Flow MFP E52645").
  //    Algumas Samsung devolvem codigo interno ("IMP1757", "HP754FF7"), que nao
  //    diz nada a quem usa a tela: nesse caso vale mais o nome do sysDescr.
  let modelo = null;
  const mvb = await getUma(ip, [OID_MODELO], cfg);
  if (mvb) modelo = texto(valor(mvb[0]));
  if (!modelo || pareceCodigoInterno(modelo)) {
    modelo = modeloDoDescricao(descricao) || modelo;
  }

  // 3) consumiveis: um slot por requisicao (ver nota no topo do arquivo)
  const consumiveis = [];
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    const vbs = await getUma(ip, [
      `${OID_DESC}.1.${slot}`,
      `${OID_CAPACIDADE}.1.${slot}`,
      `${OID_NIVEL}.1.${slot}`,
    ], cfg);
    if (!vbs) continue;

    const c = normalizarConsumivel({
      slot,
      nome: valor(vbs[0]),
      capacidade: valor(vbs[1]),
      nivel: valor(vbs[2]),
    });
    if (c) consumiveis.push(c);
  }

  return {
    ip,
    descricao,
    modelo,
    serie,
    paginas: Number.isFinite(Number(paginas)) ? Number(paginas) : null,
    consumiveis,
  };
}

/** Extrai um nome curto do modelo a partir do sysDescr (fallback). */
export function modeloDoDescricao(descricao) {
  if (!descricao) return null;
  // "Samsung SL-M4020ND; V4.00.02.22 ..." -> "SL-M4020ND"
  const parte = descricao.split(';')[0].trim();
  const palavras = parte.split(/\s+/);
  if (palavras.length > 1) return palavras.slice(1).join(' ');
  return parte || null;
}

/**
 * Detecta nome de modelo que nao serve para exibir.
 *
 * Algumas Samsung reportam codigos internos de firmware no
 * prtGeneralModelName: "IMP1757", "HP754FF7". Nao tem hifen, nao tem palavra,
 * e nao ajuda ninguem na lista — melhor usar o sysDescr, que traz
 * "Samsung SL-M4020ND".
 */
export function pareceCodigoInterno(nome) {
  if (!nome) return true;
  const t = String(nome).trim();
  if (!t) return true;
  // sem espaco e com digitos colados em letras: "IMP1757", "HP754FF7"
  if (!/\s/.test(t) && /\d/.test(t) && /^[A-Za-z0-9-]+$/.test(t)) return true;
  return false;
}
