/**
 * Autenticacao web baseada em sessao de servidor.
 *
 * O cookie carrega apenas um token aleatorio; o dono da sessao, o prazo e a
 * revogacao vivem no banco (tabela sessoes). Assim, remover ou desativar um
 * usuario derruba o acesso dele na hora, sem esperar o cookie expirar.
 *
 * Senhas nunca sao gravadas: o AD valida a credencial e o sistema guarda
 * apenas QUEM pode entrar.
 */
import crypto from 'node:crypto';

const COOKIE = 'voip_session';
export const SESSION_COOKIE_NAME = COOKIE;
export const SESSAO_HORAS = 12;

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function tokenDaRequisicao(req) {
  return parseCookies(req)[COOKIE] || null;
}

/** Token opaco de 32 bytes; nada sobre o usuario trafega no cookie. */
export function gerarToken() {
  return crypto.randomBytes(32).toString('hex');
}

function apenasHex(s) {
  return typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
}

export function cookieSessao(token, { maxAge = SESSAO_HORAS * 3600 } = {}) {
  if (!apenasHex(token)) return cookieLimpo();
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function cookieLimpo() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Escapa texto para interpolar em HTML com seguranca. */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ESTILO_BASE = `
  :root {
    color-scheme: dark;
    --bg: #0c0f14; --surface: #14181f; --surface-2: #1a1f27; --surface-3: #10141a;
    --line: #252a35; --line-strong: #384050;
    --text: #e9ecf2; --text-2: #c2c9d6; --muted: #8a93a6;
    --accent: #4f8cff; --accent-hover: #6ba0ff; --accent-soft: rgba(79,140,255,.16);
    --accent-border: rgba(79,140,255,.34); --accent-text: #9fc0ff; --on-accent: #fff;
    --ok: #2ecc71; --ok-text: #6fe3a3; --ok-soft: rgba(46,204,113,.12); --ok-border: rgba(46,204,113,.38);
    --bad: #e74c3c; --bad-text: #ff9187; --bad-soft: rgba(231,76,60,.12); --bad-border: rgba(231,76,60,.40);
    --warn: #f1c40f; --warn-text: #f5cd53;
    --shadow-lg: 0 28px 80px rgba(0,0,0,.62); --shadow-md: 0 10px 30px rgba(0,0,0,.38);
    --glow: rgba(79,140,255,.12);
    --r-sm: 7px; --r-md: 10px; --r-lg: 14px;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f3f5f9; --surface: #ffffff; --surface-2: #f7f9fc; --surface-3: #eff3f8;
      --line: #e1e6ef; --line-strong: #c8d1df;
      --text: #15191f; --text-2: #3c4453; --muted: #667085;
      --accent: #2563eb; --accent-hover: #1d4ed8; --accent-soft: rgba(37,99,235,.12);
      --accent-border: rgba(37,99,235,.26); --accent-text: #1d4ed8;
      --ok: #16a34a; --ok-text: #15803d; --ok-soft: rgba(22,163,74,.10); --ok-border: rgba(22,163,74,.30);
      --bad: #dc2626; --bad-text: #b91c1c; --bad-soft: rgba(220,38,38,.09); --bad-border: rgba(220,38,38,.28);
      --warn: #d97706; --warn-text: #b45309;
      --shadow-lg: 0 28px 70px rgba(15,23,42,.18); --shadow-md: 0 8px 24px rgba(15,23,42,.10);
      --glow: rgba(37,99,235,.08);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin:0; min-height:100vh;
    color: var(--text); font:14px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  input {
    width: 100%; background: var(--surface-2); border: 1px solid var(--line); color: var(--text);
    padding: 11px 13px; border-radius: 9px; font-size: 15px; outline: none;
    font-family: inherit; transition: border-color .15s ease, box-shadow .15s ease;
  }
  input:hover { border-color: var(--line-strong); }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); background: var(--surface); }
  button {
    background: var(--accent); color: var(--on-accent); border: 0; border-radius: 9px;
    padding: 11px 18px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit;
    transition: filter .15s ease, transform .06s ease;
  }
  button:hover { filter: brightness(1.08); }
  button:active { transform: translateY(1px); }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .btn-sec {
    background: var(--surface-2); color: var(--text-2); border: 1px solid var(--line);
  }
  .btn-sec:hover { border-color: var(--line-strong); color: var(--text); filter: none; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

const ICONE_TELEFONE = `<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/></svg>`;

/**
 * Tela de login.
 * @param {{erro?: string, aviso?: string, login?: string}} dados
 */
export function paginaLogin({ erro = '', aviso = '', login = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Entrar — Monitor VoIP</title>
<style>
  ${ESTILO_BASE}
  body {
    display:flex; align-items:center; justify-content:center;
    background: radial-gradient(circle at 50% -10%, var(--glow) 0%, transparent 55%), var(--bg);
  }
  .box {
    width: 380px; background: var(--surface); border: 1px solid var(--line);
    border-radius: 16px; padding: 30px 28px 26px; box-shadow: var(--shadow-lg);
  }
  .logo {
    width: 46px; height: 46px; border-radius: 12px; margin-bottom: 18px;
    background: var(--accent); color: var(--on-accent);
    display:flex; align-items:center; justify-content:center; box-shadow: 0 6px 18px var(--accent-soft);
  }
  .logo svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2;
    stroke-linecap: round; stroke-linejoin: round; }
  h1 { font-size: 19px; margin: 0 0 5px; font-weight: 650; letter-spacing: -.015em; }
  p.sub { margin: 0 0 24px; color: var(--muted); font-size: 13px; }
  label {
    display:block; font-size: 11px; color: var(--muted); text-transform: uppercase;
    letter-spacing:.07em; margin-bottom: 7px; font-weight: 600;
  }
  .campo { margin-bottom: 15px; }
  .msg {
    border-radius: 8px; padding: 10px 13px; font-size: 13px; margin-bottom: 16px;
    border: 1px solid transparent;
  }
  .msg.erro { background: var(--bad-soft); border-color: var(--bad-border); color: var(--bad-text); }
  .msg.aviso { background: var(--accent-soft); border-color: var(--accent-border); color: var(--accent-text); }
  button[type=submit] { width: 100%; margin-top: 5px; padding: 12px; font-size: 15px; }
  .foot { margin-top: 20px; color: var(--muted); font-size: 11.5px; text-align: center; line-height: 1.6; }
  .foot code {
    font-family: Consolas, monospace; background: var(--surface-2); padding: 1px 5px;
    border-radius: 4px; border: 1px solid var(--line); font-size: 11px;
  }
</style>
</head>
<body>
<form class="box" method="POST" action="/login">
  <div class="logo" aria-hidden="true">${ICONE_TELEFONE}</div>
  <h1>Monitor VoIP</h1>
  <p class="sub">Inventário e monitoramento de telefones IP</p>

  ${erro ? `<div class="msg erro">${esc(erro)}</div>` : ''}
  ${aviso ? `<div class="msg aviso">${esc(aviso)}</div>` : ''}

  <div class="campo">
    <label for="u">Usuário</label>
    <input type="text" id="u" name="username" autocomplete="username"
           value="${esc(login)}" placeholder="ex.: x344942" autofocus required
           autocapitalize="none" autocorrect="off" spellcheck="false">
  </div>
  <div class="campo">
    <label for="p">Senha do domínio</label>
    <input type="password" id="p" name="password" autocomplete="current-password" required>
  </div>
  <button type="submit">Entrar</button>

  <div class="foot">
    Autenticação pelo Active Directory<br>
    Acesso restrito a usuários cadastrados · sessão de ${SESSAO_HORAS} horas
  </div>
</form>
<script>
  // se a senha voltou vazia apos um erro, foca o campo de senha
  if (document.querySelector('.msg.erro')) document.getElementById('p').focus();
</script>
</body>
</html>`;
}

/** Tela de erro de acesso (403). */
export function paginaNegado(motivo) {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Acesso negado — Monitor VoIP</title>
<style>
  ${ESTILO_BASE}
  body { display:flex; align-items:center; justify-content:center;
    background: radial-gradient(circle at 50% -10%, var(--glow) 0%, transparent 55%), var(--bg); }
  .box {
    width: 420px; background: var(--surface); border: 1px solid var(--line);
    border-radius: 16px; padding: 30px 28px; box-shadow: var(--shadow-lg); text-align: center;
  }
  .icone {
    width: 48px; height: 48px; border-radius: 50%; margin: 0 auto 16px;
    background: var(--bad-soft); border: 1px solid var(--bad-border);
    display:flex; align-items:center; justify-content:center;
  }
  .icone svg { width: 24px; height: 24px; fill:none; stroke: var(--bad); stroke-width: 2;
    stroke-linecap: round; stroke-linejoin: round; }
  h1 { font-size: 18px; margin: 0 0 8px; font-weight: 650; }
  p { color: var(--muted); font-size: 13.5px; margin: 0 0 22px; line-height: 1.6; }
  a { color: var(--accent-text); text-decoration: none; font-size: 13.5px; }
  a:hover { text-decoration: underline; }
</style>
</head><body>
<div class="box">
  <div class="icone"><svg viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg></div>
  <h1>Acesso não autorizado</h1>
  <p>${esc(motivo || 'Sua conta não está cadastrada neste sistema.')}</p>
  <a href="/logout">Sair e tentar outro usuário</a>
</div>
</body></html>`;
}
