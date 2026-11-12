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
<title>Entrar — Monitor VoIP</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#2a2f3a; --text:#e6e9ef; --muted:#8b93a7; --accent:#4f8cff; --bad:#e74c3c; }
  * { box-sizing: border-box; }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background: radial-gradient(circle at 50% 0%, #1b2230 0%, var(--bg) 55%);
    color: var(--text); font:14px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  .box {
    width: 360px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 14px; padding: 30px 28px 26px; box-shadow: 0 24px 70px rgba(0,0,0,.55);
  }
  .logo { width: 44px; height: 44px; border-radius: 11px; background: var(--accent); margin-bottom: 16px;
          display:flex; align-items:center; justify-content:center; font-size: 22px; }
  h1 { font-size: 19px; margin: 0 0 4px; font-weight: 620; }
  p.sub { margin: 0 0 22px; color: var(--muted); font-size: 13px; }
  label { display:block; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing:.06em; margin-bottom: 6px; }
  input {
    width: 100%; background: #1e222b; border: 1px solid var(--line); color: var(--text);
    padding: 11px 13px; border-radius: 9px; font-size: 15px; outline: none; margin-bottom: 16px;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(79,140,255,.18); }
  button {
    width: 100%; background: var(--accent); color: #fff; border: 0; border-radius: 9px;
    padding: 12px; font-size: 15px; font-weight: 600; cursor: pointer;
  }
  button:hover { filter: brightness(1.1); }
  .err { display:none; background: rgba(231,76,60,.12); border: 1px solid rgba(231,76,60,.4);
         color: #ff9a8f; padding: 9px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
  .foot { margin-top: 18px; color: var(--muted); font-size: 11.5px; text-align: center; }
</style>
</head>
<body>
<form class="box" method="POST" action="/login">
  <div class="logo">📞</div>
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
