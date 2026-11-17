/**
 * Configuracao do Active Directory.
 *
 * Os DCs vem com failover: o ldapjs tenta o proximo quando a conexao falha,
 * entao um controlador fora do ar nao derruba o login.
 *
 * Credenciais NAO ficam no codigo: use o arquivo .env (ignorado pelo git).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Le o .env da raiz do projeto (sem dependencia externa). */
function lerEnv(raiz) {
  const out = {};
  const arquivo = path.join(raiz, '.env');
  try {
    for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
      const t = linha.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      const chave = t.slice(0, i).trim();
      let valor = t.slice(i + 1).trim();
      // remove aspas envolventes
      if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
        valor = valor.slice(1, -1);
      }
      out[chave] = valor;
    }
  } catch {
    // sem .env: usa somente o ambiente e os padroes
  }
  return out;
}

/**
 * Monta a configuracao a partir das variaveis de ambiente e do .env.
 * A precedencia e: variavel de ambiente > .env > padrao.
 *
 * @param {string} raiz Raiz do projeto (onde mora o .env)
 */
export function carregarConfigAd(raiz = process.cwd()) {
  const env = { ...lerEnv(raiz), ...process.env };

  const urls = String(env.AD_URL || '')
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean);

  return {
    // Site Datacenter (rede.sp). Define AD_URL para usar outros.
    url: urls.length ? urls : [
      'ldap://c65v90i.rede.sp',
      'ldap://c65v91i.rede.sp',
      'ldap://c68v42i.rede.sp',
      'ldap://c68v47i.rede.sp',
    ],
    baseDN: env.AD_BASE_DN || 'DC=rede,DC=sp',
    domain: env.AD_DOMAIN || 'rede.sp',
    // Conta usada apenas para BUSCAR usuarios (tela de cadastro).
    // O login do usuario final nao usa isso: ele faz bind com a propria senha.
    buscaUsuario: env.AD_SEARCH_USER || '',
    buscaSenha: env.AD_SEARCH_PASSWORD || '',
    timeoutMs: Number(env.AD_TIMEOUT_MS || 8000),
  };
}

/**
 * Ambiente de desenvolvimento: permite testar o fluxo sem AD.
 * NUNCA deve ser ligado em producao.
 */
export function usarMock() {
  return process.env.AD_MOCK === '1';
}
