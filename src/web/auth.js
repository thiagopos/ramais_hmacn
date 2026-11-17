/**
 * Tela de login + sessao por cookie para a interface web.
 * Sem dependencias: senha conferida com hash SHA-256 e comparacao de tempo constante.
 */
import crypto from 'node:crypto';

const COOKIE = 'voip_session';
const MAX_AGE_S = 12 * 60 * 60; // 12h

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest();
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Valor de cookie assinado: uma sessao valida = hash(senha + segredo). */
export function sessionToken(password, secret) {
  return crypto.createHmac('sha256', secret).update('voip:' + password).digest('hex');
}

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

export function isAuthed(req, { password, secret }) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return false;
  return safeEqual(token, sessionToken(password, secret));
}

export function checkPassword(input, expected) {
  return safeEqual(sha256(input), sha256(expected));
}

export const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Entrar — Monitor VoIP</title>
<style>
  /* Mesmos tokens da interface principal: tema escuro por padrao,
     claro quando o sistema/navegador pede. */
  :root {
    color-scheme: dark;
    --bg: #0c0f14;
    --surface: #14181f;
    --surface-2: #1a1f27;
    --line: #252a35;
    --line-strong: #384050;
    --text: #e9ecf2;
    --muted: #8a93a6;
    --accent: #4f8cff;
    --accent-hover: #6ba0ff;
    --accent-soft: rgba(79, 140, 255, .16);
    --on-accent: #ffffff;
    --bad: #e74c3c;
    --bad-text: #ff9187;
    --bad-soft: rgba(231, 76, 60, .12);
    --bad-border: rgba(231, 76, 60, .40);
    --shadow-lg: 0 28px 80px rgba(0, 0, 0, .62);
    --glow: rgba(79, 140, 255, .12);
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f3f5f9;
      --surface: #ffffff;
      --surface-2: #f7f9fc;
      --line: #e1e6ef;
      --line-strong: #c8d1df;
      --text: #15191f;
      --muted: #667085;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --accent-soft: rgba(37, 99, 235, .12);
      --bad: #dc2626;
      --bad-text: #b91c1c;
      --bad-soft: rgba(220, 38, 38, .09);
      --bad-border: rgba(220, 38, 38, .28);
      --shadow-lg: 0 28px 70px rgba(15, 23, 42, .18);
      --glow: rgba(37, 99, 235, .08);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:
      radial-gradient(circle at 50% -10%, var(--glow) 0%, transparent 55%),
      var(--bg);
    color: var(--text); font:14px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .box {
    width: 360px; background: var(--surface); border: 1px solid var(--line);
    border-radius: 16px; padding: 30px 28px 26px; box-shadow: var(--shadow-lg);
  }
  .logo {
    width: 46px; height: 46px; border-radius: 12px; margin-bottom: 18px;
    background: var(--accent); color: var(--on-accent);
    display:flex; align-items:center; justify-content:center;
    box-shadow: 0 6px 18px var(--accent-soft);
  }
  .logo svg {
    width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2;
    stroke-linecap: round; stroke-linejoin: round;
  }
  h1 { font-size: 19px; margin: 0 0 5px; font-weight: 650; letter-spacing: -.015em; }
  p.sub { margin: 0 0 24px; color: var(--muted); font-size: 13px; }
  label {
    display:block; font-size: 11px; color: var(--muted); text-transform: uppercase;
    letter-spacing:.07em; margin-bottom: 7px; font-weight: 600;
  }
  input {
    width: 100%; background: var(--surface-2); border: 1px solid var(--line); color: var(--text);
    padding: 11px 13px; border-radius: 9px; font-size: 15px; outline: none; margin-bottom: 16px;
    font-family: inherit;
    transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
  }
  input:hover { border-color: var(--line-strong); }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); background: var(--surface); }
  button {
    width: 100%; background: var(--accent); color: var(--on-accent); border: 0; border-radius: 9px;
    padding: 12px; font-size: 15px; font-weight: 600; cursor: pointer; font-family: inherit;
    transition: filter .15s ease, transform .06s ease;
  }
  button:hover { filter: brightness(1.08); }
  button:active { transform: translateY(1px); }
  .err {
    display:none; background: var(--bad-soft); border: 1px solid var(--bad-border);
    color: var(--bad-text); padding: 10px 13px; border-radius: 8px; font-size: 13px; margin-bottom: 16px;
  }
  .foot { margin-top: 20px; color: var(--muted); font-size: 11.5px; text-align: center; }
</style>
</head>
<body>
<form class="box" method="POST" action="/login">
  <div class="logo" aria-hidden="true">
    <svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/></svg>
  </div>
  <h1>Monitor VoIP</h1>
  <p class="sub">Inventário e monitoramento de telefones IP</p>
  <div class="err" id="err">Senha incorreta. Tente novamente.</div>
  <label for="p">Senha de acesso</label>
  <input type="password" id="p" name="password" autocomplete="current-password" autofocus required>
  <button type="submit">Entrar</button>
  <div class="foot">Acesso restrito · sessão de 12 horas</div>
</form>
<script>
  if (new URLSearchParams(location.search).get('e') === '1') {
    document.getElementById('err').style.display = 'block';
    document.getElementById('p').select();
  }
</script>
</body>
</html>`;

export function setSessionCookie() {
  return `${COOKIE}=SESSION; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export const SESSION_COOKIE_NAME = COOKIE;
