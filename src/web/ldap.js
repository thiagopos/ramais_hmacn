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
 * Busca usuarios no AD para a tela de cadastro.
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

  // escapa metacaracteres de filtro LDAP: * ( ) \ NUL
  const seguro = t.replace(/\\/g, '\\5c').replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28').replace(/\)/g, '\\29').replace(/\x00/g, '\\00');

  const filtro = `(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))`
    + `(|(sAMAccountName=${seguro}*)(displayName=*${seguro}*)(mail=${seguro}*)))`;

  const client = criarCliente(cfg, { timeout: cfg.timeoutMs, connectTimeout: 4000 });
  try {
    await bindProtegido(client, `${cfg.buscaUsuario}@${cfg.domain}`, cfg.buscaSenha, cfg.timeoutMs);

    return await new Promise((resolve, reject) => {
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
        if (achados.length) return resolve(achados); // parcial e util
        reject(new Error('LDAP: tempo esgotado na busca'));
      }, cfg.timeoutMs);

      client.once('error', aoFalhar);
      client.search(cfg.baseDN, {
        filter: filtro, scope: 'sub', attributes: ATRIBUTOS, sizeLimit: limite, timeLimit: 20,
      }, (err, res) => {
        if (err) return aoFalhar(err);
        res.on('searchEntry', (entry) => {
          const o = {};
          for (const a of entry.attributes || []) {
            const nome = a.type || a.name;
            if (nome) o[nome] = (a.values || []).length === 1 ? a.values[0] : a.values;
          }
          achados.push(mapear(o));
        });
        res.on('end', () => {
          if (terminou) return;
          terminou = true; limpar();
          resolve(achados);
        });
        res.on('error', (e) => {
          const msg = String(e?.message || e).toLowerCase();
          // estourar o limite de resultados nao e erro: ja temos o que mostrar
          if (msg.includes('size limit') && achados.length) {
            if (terminou) return;
            terminou = true; limpar();
            return resolve(achados);
          }
          aoFalhar(e);
        });
      });
    });
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
