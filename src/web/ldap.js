/**
 * Servico LDAP/AD: autenticacao de usuario e busca para o cadastro.
 *
 * Baseado no que o projeto hmacn-acesso aprendeu em producao:
 *  - o ldapjs deixa a promise PENDENTE para sempre quando a rede falha;
 *    toda operacao aqui tem timeout proprio e limpa o listener de 'error'
 *  - sem listener de 'error', uma falha de conexao derruba o processo Node
 *  - bind por UPN (usuario@dominio) e o formato que funciona neste AD;
 *    o DN fixo (CN=login,OU=Users,DC=...) nao existe — o DN real tem o nome
 *    completo e uma OU intermediaria, o que muda por pessoa
 */
import ldap from 'ldapjs';

/** Atributos que a tela de cadastro usa. */
export const ATRIBUTOS = [
  'sAMAccountName', 'displayName', 'mail', 'department', 'title',
  'company', 'telephoneNumber', 'distinguishedName',
];

/**
 * Atributos do Explorador AD: tudo que ajuda a identificar uma pessoa.
 * Inclui os do cadastro mais UPN, celular, gestor, grupos e data de criacao.
 */
export const ATRIBUTOS_EXPLORADOR = [
  'cn', 'sn', 'givenName', 'displayName', 'mail', 'sAMAccountName',
  'userPrincipalName', 'department', 'title', 'telephoneNumber',
  'mobile', 'company', 'manager', 'memberOf', 'whenCreated',
  'name', 'distinguishedName', 'description',
];

/**
 * Normaliza um entry LDAP do Explorador para a interface.
 * `memberOf` vem como lista de DNs: mostramos so o CN de cada grupo.
 */
export function mapearExplorador(raw) {
  const um = (v) => (Array.isArray(v) ? v[0] : v) || '';
  const lista = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
  const cnDoDn = (dn) => {
    const m = String(dn).match(/^CN=([^,]+)/i);
    return m ? m[1] : String(dn);
  };

  return {
    login: um(raw.sAMAccountName),
    nome: um(raw.displayName) || um(raw.cn) || um(raw.name),
    sobrenome: um(raw.sn),
    primeiroNome: um(raw.givenName),
    email: um(raw.mail),
    upn: um(raw.userPrincipalName),
    departamento: um(raw.department),
    cargo: um(raw.title),
    empresa: um(raw.company),
    telefone: um(raw.telephoneNumber),
    celular: um(raw.mobile),
    descricao: um(raw.description),
    gestor: um(raw.manager) ? cnDoDn(um(raw.manager)) : '',
    grupos: lista(raw.memberOf).map(cnDoDn),
    criadoEm: um(raw.whenCreated),
    dn: um(raw.distinguishedName),
  };
}

/**
 * Cria um cliente LDAP com failover entre DCs e timeout curto.
 * @param {{url: string|string[], timeoutMs?: number}} cfg
 */
export function criarCliente(cfg, { timeout = 8000, connectTimeout = 4000 } = {}) {
  const client = ldap.createClient({
    url: cfg.url,
    timeout,
    connectTimeout,
    // um DC lento nao deve segurar o login: passa para o proximo
    failoverOnError: true,
  });
  // Sem este listener, um erro de conexao emitido sem handler derruba o processo.
  client.on('error', (err) => {
    console.warn('[LDAP] erro de conexao:', err?.message || String(err));
  });
  return client;
}

/**
 * Bind com timeout proprio.
 *
 * O ldapjs nao rejeita a promise quando a conexao cai no meio: sem o timer
 * e o listener de 'error' abaixo, a requisicao HTTP ficaria pendurada.
 *
 * @returns {Promise<void>} resolve em sucesso, rejeita em falha
 */
function bindProtegido(client, dn, senha, timeoutMs) {
  return new Promise((resolve, reject) => {
    let terminou = false;

    const limpar = () => {
      clearTimeout(timer);
      client.removeListener('error', aoFalharConexao);
    };
    const aoFalharConexao = (err) => {
      if (terminou) return;
      terminou = true;
      limpar();
      reject(new Error('LDAP: ' + (err?.message || String(err))));
    };
    const timer = setTimeout(() => {
      if (terminou) return;
      terminou = true;
      limpar();
      reject(new Error('LDAP: tempo esgotado ao contatar o Active Directory'));
    }, timeoutMs);

    client.once('error', aoFalharConexao);
    client.bind(dn, senha, (err) => {
      if (terminou) return;
      terminou = true;
      limpar();
      if (err) return reject(err);
      resolve();
    });
  });
}

/**
 * Distingue falha de INFRAESTRUTURA de credencial errada.
 * Senha errada nao pode ser tratada como "AD fora", nem o contrario.
 */
export function ehErroConexao(err) {
  const msg = String(err?.message || err).toLowerCase();
  return /connect|timeout|etimedout|econn|socket|network|closed|reset|unreachable|tempo esgotado/i.test(msg);
}

/**
 * Autentica um usuario no AD.
 *
 * Usa bind por UPN. Nao ha fallback por DN porque neste diretorio o DN
 * contem o nome completo e uma OU intermediaria (ex.:
 * "CN=Thiago Gomes Possa,OU=Users,OU=SMS,DC=rede,DC=sp"), impossivel de
 * montar a partir do login.
 *
 * @param {object} cfg configuracao do AD
 * @param {string} login sAMAccountName (ex.: x344942)
 * @param {string} senha senha digitada pelo usuario
 * @returns {Promise<{ok: boolean, conexao?: boolean, erro?: string}>}
 */
export async function autenticar(cfg, login, senha) {
  const usuario = String(login || '').trim();
  const pass = String(senha || '');
  if (!usuario || !pass) return { ok: false, erro: 'Usuário e senha são obrigatórios.' };

  const client = criarCliente(cfg, { timeout: cfg.timeoutMs, connectTimeout: 4000 });
  try {
    await bindProtegido(client, `${usuario}@${cfg.domain}`, pass, cfg.timeoutMs);
    return { ok: true };
  } catch (err) {
    if (ehErroConexao(err)) {
      return { ok: false, conexao: true, erro: 'Não foi possível contatar o Active Directory.' };
    }
    // InvalidCredentials cobre senha errada E usuario inexistente: nao
    // distinguir os dois evita confirmar quais logins existem.
    return { ok: false, erro: 'Usuário ou senha inválidos.' };
  } finally {
    try { client.destroy(); } catch { /* ja fechado */ }
  }
}

/**
 * Busca usuarios no AD para a tela de cadastro (por login OU nome).
 * Usa uma conta de servico (so leitura), nunca a senha do usuario logado.
 *
 * @param {object} cfg
 * @param {string} termo login, nome ou parte do nome
 * @param {number} [limite]
 * @returns {Promise<Array<object>>}
 */
export async function buscarUsuarios(cfg, termo, limite = 25) {
  const t = String(termo || '').trim();
  if (t.length < 2) return [];
  if (!cfg.buscaUsuario || !cfg.buscaSenha) {
    throw new Error('Busca no AD não configurada. Defina AD_SEARCH_USER e AD_SEARCH_PASSWORD no .env.');
  }

  const seguro = escaparFiltro(t);
  // contas desativadas (bit ACCOUNTDISABLE) ficam de fora
  const filtro = `(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))`
    + `(|(sAMAccountName=${seguro}*)(displayName=*${seguro}*)(mail=${seguro}*)))`;

  const client = criarCliente(cfg, { timeout: cfg.timeoutMs, connectTimeout: 4000 });
  try {
    await bindProtegido(client, `${cfg.buscaUsuario}@${cfg.domain}`, cfg.buscaSenha, cfg.timeoutMs);
    const achados = await buscarEntradas(client, cfg, filtro, ATRIBUTOS, limite);
    return achados.map(mapear);
  } finally {
    try { client.destroy(); } catch { /* ja fechado */ }
  }
}

/** Normaliza um entry LDAP para o formato usado pela interface. */
export function mapear(raw) {
  const um = (v) => (Array.isArray(v) ? v[0] : v) || '';
  return {
    login: um(raw.sAMAccountName),
    nome: um(raw.displayName) || um(raw.cn) || um(raw.name),
    email: um(raw.mail),
    departamento: um(raw.department),
    cargo: um(raw.title),
    empresa: um(raw.company),
    telefone: um(raw.telephoneNumber),
    dn: um(raw.distinguishedName),
  };
}

/**
 * Busca UM usuario pelo login exato (sAMAccountName).
 *
 * Reproduz o comportamento do hmacn-acesso:
 *  - retry automatico em erro de CONEXAO (2 tentativas); senha errada nao
 *    repete, porque nao adianta
 *  - falha de rede e distinguida de "nao encontrado": a primeira vira erro
 *    502 com mensagem, a segunda vira resposta vazia
 *
 * @param {object} cfg
 * @param {string} login sAMAccountName (ex.: x344942)
 * @returns {Promise<{encontrado: boolean, pessoa?: object, erro?: string, conexao?: boolean}>}
 */
export async function buscarPorLogin(cfg, login) {
  const alvo = String(login || '').trim();
  if (!alvo) return { encontrado: false };
  if (!cfg.buscaUsuario || !cfg.buscaSenha) {
    return {
      encontrado: false,
      erro: 'Busca no AD não configurada. Defina AD_SEARCH_USER e AD_SEARCH_PASSWORD no .env.',
    };
  }

  const filtro = '(sAMAccountName=' + escaparFiltro(alvo) + ')';
  let ultimoErro = null;

  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const client = criarCliente(cfg, { timeout: cfg.timeoutMs, connectTimeout: 4000 });
    try {
      await bindProtegido(client, `${cfg.buscaUsuario}@${cfg.domain}`, cfg.buscaSenha, cfg.timeoutMs);
      const achados = await buscarEntradas(client, cfg, filtro, ATRIBUTOS, 5);
      if (!achados.length) return { encontrado: false };
      return { encontrado: true, pessoa: mapear(achados[0]) };
    } catch (err) {
      ultimoErro = err;
      // so vale repetir quando o problema e de rede, nao de credencial/filtro
      if (!ehErroConexao(err) || tentativa === 2) break;
    } finally {
      try { client.destroy(); } catch { /* ja fechado */ }
    }
  }

  return {
    encontrado: false,
    conexao: ehErroConexao(ultimoErro),
    erro: 'Falha ao consultar o Active Directory: ' + (ultimoErro?.message || String(ultimoErro)),
  };
}

/**
 * Escapa metacaracteres de filtro LDAP: * ( ) \ e NUL.
 * Sem isso, um login como "x)(sAMAccountName=*" quebraria o filtro.
 */
export function escaparFiltro(str) {
  return String(str || '')
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\x00/g, '\\00');
}

/**
 * Explorador AD — busca por NOME com prefix match.
 *
 * Prefixo usa o indice do AD, entao e rapido. Procura nos quatro campos em
 * que um nome pode estar grafado: displayName, cn, name e sn (sobrenome).
 * Ex.: "silva" acha "Silva, Maria" pelo sn; "Maria" acha pelo displayName.
 *
 * Tem comportamento identico ao Explorador da intranet.
 *
 * @param {object} cfg
 * @param {string} termo
 * @returns {Promise<Array<object>>}
 */
export async function buscarExploradorPorNome(cfg, termo) {
  const t = String(termo || '').trim();
  if (!t) return [];
  if (!cfg.buscaUsuario || !cfg.buscaSenha) {
    throw new Error('Busca no AD não configurada. Defina AD_SEARCH_USER e AD_SEARCH_PASSWORD no .env.');
  }

  const s = escaparFiltro(t);
  const filtro = `(&(objectCategory=person)`
    + `(|(displayName=${s}*)(cn=${s}*)(name=${s}*)(sn=${s}*)))`;

  const client = criarCliente(cfg, { timeout: cfg.timeoutMs, connectTimeout: 4000 });
  try {
    await bindProtegido(client, `${cfg.buscaUsuario}@${cfg.domain}`, cfg.buscaSenha, cfg.timeoutMs);
    const achados = await buscarEntradas(client, cfg, filtro, ATRIBUTOS_EXPLORADOR, 200);
    return achados.map(mapearExplorador);
  } finally {
    try { client.destroy(); } catch { /* ja fechado */ }
  }
}

/**
 * Explorador AD — busca por LISTA de logins (sAMAccountName exato).
 *
 * Monta um filtro OR unico com todos os logins, em vez de uma consulta por
 * login: 50 logins custam uma ida ao AD, nao 50.
 *
 * Devolve tambem quem NAO foi encontrado — e o dado mais importante para
 * conferir uma lista copiada de outro sistema.
 *
 * @param {object} cfg
 * @param {string[]} logins
 * @returns {Promise<{encontrados: object[], naoEncontrados: string[]}>}
 */
export async function buscarExploradorPorLogins(cfg, logins) {
  const unicos = [...new Set(
    (Array.isArray(logins) ? logins : [])
      .map((l) => String(l || '').trim())
      .filter(Boolean),
  )];
  if (!unicos.length) return { encontrados: [], naoEncontrados: [] };
  if (!cfg.buscaUsuario || !cfg.buscaSenha) {
    throw new Error('Busca no AD não configurada. Defina AD_SEARCH_USER e AD_SEARCH_PASSWORD no .env.');
  }
  if (unicos.length > 500) {
    throw new Error('Máximo de 500 logins por busca.');
  }

  const partes = unicos.map((l) => `(sAMAccountName=${escaparFiltro(l)})`).join('');
  const filtro = unicos.length === 1 ? partes : `(|${partes})`;

  const client = criarCliente(cfg, { timeout: cfg.timeoutMs, connectTimeout: 4000 });
  try {
    await bindProtegido(client, `${cfg.buscaUsuario}@${cfg.domain}`, cfg.buscaSenha, cfg.timeoutMs);
    const achados = await buscarEntradas(client, cfg, filtro, ATRIBUTOS_EXPLORADOR, 500);
    const encontrados = achados.map(mapearExplorador);

    // o AD compara login sem diferenciar maiuscula: normalizamos para saber
    // quem realmente nao existe
    const achadosSet = new Set(encontrados.map((u) => u.login.toLowerCase()));
    const naoEncontrados = unicos.filter((l) => !achadosSet.has(l.toLowerCase()));

    return { encontrados, naoEncontrados };
  } finally {
    try { client.destroy(); } catch { /* ja fechado */ }
  }
}

/** Executa uma busca ja autenticada e devolve os entries crus. */
function buscarEntradas(client, cfg, filtro, atributos, limite) {
  return new Promise((resolve, reject) => {
    const achados = [];
    let terminou = false;
    const limpar = () => { clearTimeout(timer); client.removeListener('error', aoFalhar); };
    const aoFalhar = (err) => {
      if (terminou) return;
      terminou = true; limpar();
      reject(new Error('LDAP: ' + (err?.message || String(err))));
    };
    const timer = setTimeout(() => {
      if (terminou) return;
      terminou = true; limpar();
      if (achados.length) return resolve(achados);
      reject(new Error('LDAP: tempo esgotado na busca'));
    }, cfg.timeoutMs);

    client.once('error', aoFalhar);
    client.search(cfg.baseDN, {
      filter: filtro, scope: 'sub', attributes: atributos, sizeLimit: limite, timeLimit: 20,
    }, (err, res) => {
      if (err) return aoFalhar(err);
      res.on('searchEntry', (entry) => {
        const o = {};
        for (const a of entry.attributes || []) {
          const nome = a.type || a.name;
          if (nome) o[nome] = (a.values || []).length === 1 ? a.values[0] : a.values;
        }
        achados.push(o);
      });
      res.on('end', () => {
        if (terminou) return;
        terminou = true; limpar();
        resolve(achados);
      });
      res.on('error', (e) => {
        const msg = String(e?.message || e).toLowerCase();
        if (msg.includes('size limit') && achados.length) {
          if (terminou) return;
          terminou = true; limpar();
          return resolve(achados);
        }
        aoFalhar(e);
      });
    });
  });
}
