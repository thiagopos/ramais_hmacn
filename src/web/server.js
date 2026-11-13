/**
 * Servidor web de monitoramento (sem dependencias, http nativo).
 * Rotas:
 *   GET /                 interface (exige login)
 *   GET|POST /login       tela de login
 *   GET /logout           encerra a sessao
 *   GET /api/phones       inventario com ramal (filtros: q, status)
 *   GET /api/stats        resumos
 *   GET /api/history/:ip  amostras de uptime do aparelho
 *   GET /api/runs         historico de ciclos de monitoramento
 *   POST /api/monitor     dispara um ciclo agora (retorna ao final)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, inventoryRows, knownTargets, setoresResumo, estabilidadeResumo } from '../lib/db.js';
import { enrichPhones } from '../enrich.js';
import { DEFAULT_TARGETS } from '../config.js';
import {
  LOGIN_PAGE, SESSION_COOKIE_NAME, checkPassword, clearSessionCookie,
  parseCookies, sessionToken,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Autenticacao por tela de login + cookie de sessao (ver auth.js). */
function makeAuth(password) {
  if (!password) return null;
  const secret = crypto.randomBytes(32).toString('hex');
  const token = sessionToken(password, secret);
  return {
    token,
    /**
     * Garante sessao valida. Trata /login (GET form, POST senha) e /logout.
     * Retorna true se a requisicao ja foi tratada/liberada.
     */
    handle(req, res, route) {
      const cookies = parseCookies(req);

      if (route === '/logout') {
        res.writeHead(302, { 'Set-Cookie': clearSessionCookie(), Location: '/login' });
        res.end();
        return true;
      }

      if (route === '/login' && req.method === 'GET') {
        if (cookies[SESSION_COOKIE_NAME] && safeToken(cookies[SESSION_COOKIE_NAME], token)) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(LOGIN_PAGE);
        return true;
      }

      if (route === '/login' && req.method === 'POST') {
        return readForm(req).then((body) => {
          const qs = new URLSearchParams(body);
          const ok = checkPassword(qs.get('password') || '', password);
          if (ok) {
            res.writeHead(302, {
              'Set-Cookie': `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
              Location: '/',
            });
            res.end();
          } else {
            console.log(`[auth] senha incorreta de ${req.socket.remoteAddress}`);
            res.writeHead(302, { Location: '/login?e=1' });
            res.end();
          }
          return true;
        });
      }

      // todas as demais rotas exigem sessao
      if (cookies[SESSION_COOKIE_NAME] && safeToken(cookies[SESSION_COOKIE_NAME], token)) return false;

      if (route.startsWith('/api/')) {
        json(res, 401, { error: 'nao autenticado' });
      } else {
        res.writeHead(302, { Location: '/login' });
        res.end();
      }
      return true;
    },
  };
}

function safeToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function readForm(req, limit = 4096) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

export async function startWeb({ dbPath = 'voip.sqlite', port = 8080, host = '127.0.0.1', password } = {}) {
  // garante schema
  openDb(dbPath).close();
  const pw = password || process.env.VOIP_WEB_PASS;
  const auth = makeAuth(pw);

  // estado do monitoramento (compartilhado entre requisicoes e reidratavel)
  const mon = { running: false, startedAt: null, lastError: null, lastResult: null, promise: null };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = url.pathname;

    if (auth && route !== '/__test') {
      const handled = await auth.handle(req, res, route);
      if (handled) return;
    }

    try {
      if (route === '/api/phones' && req.method === 'GET') {
        const db = openDb(dbPath);
        let rows = inventoryRows(db);
        const setores = setoresResumo(db);
        db.close();
        const q = (url.searchParams.get('q') || '').toLowerCase().trim();
        const status = url.searchParams.get('status') || '';
        const setor = url.searchParams.get('setor') || '';
        if (q) {
          rows = rows.filter((r) =>
            [r.ip, r.ramal, r.mac, r.model, r.hostname, r.serial, r.firmware, r.setores, r.andares, r.alas]
              .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
        }
        if (status === 'online') rows = rows.filter((r) => r.online === 1);
        if (status === 'offline') rows = rows.filter((r) => r.online === 0);
        if (status === 'sem-ramal') rows = rows.filter((r) => !r.ramal);
        if (status === 'sem-setor') rows = rows.filter((r) => !r.qtd_setores);
        // instavel = ja respondeu e caiu pelo menos uma vez
        if (status === 'instavel') {
          rows = rows.filter((r) => r.em_instabilidade === 1)
            .sort((a, b) => (b.quedas - a.quedas) || (b.pct_indisponivel - a.pct_indisponivel));
        }
        if (status === 'estavel') rows = rows.filter((r) => r.em_instabilidade !== 1);
        if (setor) rows = rows.filter((r) => (r.setores || '').split(' | ').includes(setor));
        return json(res, 200, { count: rows.length, rows, setores });
      }

      if (route === '/api/setores' && req.method === 'GET') {
        const db = openDb(dbPath);
        const rows = setoresResumo(db);
        db.close();
        return json(res, 200, { count: rows.length, rows });
      }

      if (route === '/api/stats' && req.method === 'GET') {
        const db = openDb(dbPath);
        const one = (sql) => db.prepare(sql).get();
        const stats = {
          total: one(`SELECT COUNT(*) c FROM devices WHERE is_phone=1`).c,
          online: one(`SELECT COUNT(*) c FROM devices WHERE is_phone=1 AND online=1`).c,
          // desaparecidos = estavam online e agora nao respondem
          desaparecidos: one(`SELECT COUNT(*) c FROM devices WHERE is_phone=1 AND online=0`).c,
          offline: one(`SELECT COUNT(*) c FROM devices WHERE is_phone=1 AND online=0`).c,
          nuncaVerificados: one(`SELECT COUNT(*) c FROM devices WHERE is_phone=1 AND online IS NULL`).c,
          comRamal: one(`SELECT COUNT(*) c FROM devices WHERE is_phone=1 AND ramal IS NOT NULL`).c,
          modelos: db.prepare(`SELECT model, COUNT(*) c FROM devices WHERE is_phone=1 GROUP BY model ORDER BY c DESC`).all(),
          firmwares: db.prepare(`SELECT firmware, COUNT(*) c FROM devices WHERE is_phone=1 AND firmware IS NOT NULL GROUP BY firmware ORDER BY c DESC`).all(),
          ultimoCheck: one(`SELECT finished_at FROM monitor_runs ORDER BY id DESC LIMIT 1`)?.finished_at || null,
          estabilidade: estabilidadeResumo(db),
          ultimoScan: db.prepare(`SELECT finished_at, hosts_alive, phones_found FROM scans WHERE targets NOT LIKE '%monitor%' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`).get() || null,
        };
        db.close();
        return json(res, 200, stats);
      }

      if (route === '/api/desaparecidos' && req.method === 'GET') {
        const db = openDb(dbPath);
        const rows = db.prepare(
          `SELECT ip, ramal, mac, model, last_seen, missing_since
           FROM devices WHERE is_phone=1 AND online=0 ORDER BY missing_since DESC`,
        ).all();
        db.close();
        return json(res, 200, { count: rows.length, rows });
      }

      if (route === '/api/events' && req.method === 'GET') {
        const db = openDb(dbPath);
        const limit = Math.min(200, Number(url.searchParams.get('limit') || 50));
        const rows = db.prepare(
          `SELECT e.ip, e.event, e.detail, e.created_at, d.ramal
           FROM events e LEFT JOIN devices d ON d.ip = e.ip
           WHERE e.event IN ('new','disappeared','ramal_changed','offline')
           ORDER BY e.id DESC LIMIT ?`,
        ).all(limit);
        db.close();
        return json(res, 200, { events: rows });
      }

      if (route.startsWith('/api/history/') && req.method === 'GET') {
        const ip = decodeURIComponent(route.slice('/api/history/'.length));
        // janela em horas (24h por padrao, ate 30 dias)
        const hours = Math.min(720, Math.max(1, Number(url.searchParams.get('hours') || 24)));
        const since = new Date(Date.now() - hours * 3600000).toISOString();

        const db = openDb(dbPath);
        const rows = db.prepare(
          `SELECT s.created_at, s.online, s.ramal, s.firmware
           FROM monitor_samples s
           WHERE s.ip = ? AND s.created_at >= ?
           ORDER BY s.created_at ASC`,
        ).all(ip, since);

        // estatisticas da janela: cobertura, quedas e uptime
        const total = rows.length;
        const onlineCount = rows.filter((r) => r.online === 1).length;
        // quedas = transicoes online -> offline dentro da janela
        let drops = 0;
        let worstGapHours = 0;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].online === 0 && (i === 0 || rows[i - 1].online === 1)) drops++;
          if (i > 0) {
            const gap = (new Date(rows[i].created_at) - new Date(rows[i - 1].created_at)) / 3600000;
            if (gap > worstGapHours) worstGapHours = gap;
          }
        }

        // relogio dos ciclos (media de intervalo) para estimar dados faltantes
        const run = db.prepare(`SELECT started_at FROM monitor_runs ORDER BY id DESC LIMIT 2`).all();
        const step = run.length === 2
          ? Math.max(1, (new Date(run[0].started_at) - new Date(run[1].started_at)) / 3600000)
          : 1;
        db.close();

        // esperado = quantas coletas cabem na janela (~1 por ciclo)
        const expected = Math.max(1, Math.floor(hours / step));

        return json(res, 200, {
          ip,
          hours,
          step,
          samples: rows,
          stats: {
            total,
            onlineCount,
            offlineCount: total - onlineCount,
            drops,
            uptimePct: total ? Math.round((onlineCount / total) * 1000) / 10 : null,
            expected,
            worstGapHours: Math.round(worstGapHours * 10) / 10,
            coveragePct: expected ? Math.min(100, Math.round((total / expected) * 100)) : null,
          },
        });
      }

      if (route === '/api/runs' && req.method === 'GET') {
        const db = openDb(dbPath);
        const rows = db.prepare(`SELECT * FROM monitor_runs ORDER BY id DESC LIMIT 20`).all();
        db.close();
        return json(res, 200, { runs: rows });
      }

      // estado atual do monitoramento (a UI consulta ao abrir/recarregar)
      if (route === '/api/monitor/status' && req.method === 'GET') {
        return json(res, 200, {
          running: mon.running,
          startedAt: mon.startedAt,
          elapsedMs: mon.running ? Date.now() - new Date(mon.startedAt).getTime() : null,
          lastError: mon.lastError,
          lastResult: mon.lastResult,
        });
      }

      if (route === '/api/monitor' && req.method === 'POST') {
        // impede execucao concorrente: se ja esta rodando, devolve o estado
        if (mon.running) {
          return json(res, 409, {
            error: 'Já existe um monitoramento em andamento.',
            running: true,
            startedAt: mon.startedAt,
          });
        }
        mon.running = true;
        mon.startedAt = new Date().toISOString();
        mon.lastError = null;
        const t0 = Date.now();
        try {
          const r = await enrichPhones({ dbPath, verbose: false, monitor: true });
          mon.lastResult = { finishedAt: new Date().toISOString(), ...r };
          return json(res, 200, { ...r, durationMs: Date.now() - t0 });
        } catch (err) {
          mon.lastError = { at: new Date().toISOString(), message: err.message };
          console.log(`[monitor] ERRO: ${err.message}`);
          return json(res, 500, {
            error: err.message,
            hint: 'Falha ao executar o monitoramento. Veja logs/server.log para detalhes.',
          });
        } finally {
          mon.running = false;
          mon.startedAt = null;
        }
      }

      if (route === '/api/scope' && req.method === 'GET') {
        const db = openDb(dbPath);
        const scopes = knownTargets(db);
        db.close();
        return json(res, 200, { targets: scopes.length ? scopes : DEFAULT_TARGETS });
      }

      // harness de teste visual: SO de localhost (contornaria o login)
      if (route === '/__test') {
        const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (remote !== '127.0.0.1' && remote !== '::1') return json(res, 404, { error: 'not found' });
        const n = Number(url.searchParams.get('row') ?? -1);
        const click = url.searchParams.get('click') || '';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!DOCTYPE html><html><body style="margin:0">
<iframe id="f" style="width:1600px;height:880px;border:0"></iframe>
<script>
const ROW = ${n};
const CLICK = ${JSON.stringify(click)};
const f = document.getElementById('f');
async function go() {
  // garante sessao nesta origem
  const st = await fetch('/api/stats', { credentials: 'same-origin' });
  if (st.status !== 200) {
    await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=' + encodeURIComponent(${JSON.stringify(pw || '')}),
      credentials: 'same-origin',
      redirect: 'manual',
    }).catch(() => {});
  }
  f.src = '/?t=' + Date.now();
}
f.onload = () => {
  try {
    const d = f.contentDocument;
    const state = CLICK;
    if (state === 'running') {
      d.defaultView.showStatus('running', 'Monitoramento em andamento', 'varrendo o range completo… 3s');
      d.defaultView.setRunning(true);
      return;
    }
    if (state === 'ok') {
      d.defaultView.showStatus('ok', 'Monitoramento concluído', '512 IPs varridos · 236 online · 2.5s');
      return;
    }
    if (state === 'warn') {
      d.defaultView.showStatus('warn', 'Monitoramento concluído com mudanças', '512 IPs varridos · 236 online · 1 novo(s) · 2.4s — novos: ramal 1234 em 10.0.0.10');
      return;
    }
    if (state === 'err') {
      d.defaultView.showStatus('err', 'O monitoramento falhou', 'Não foi possível falar com o servidor. Ele pode estar reiniciando — tente novamente em alguns segundos.');
      return;
    }
    if (state === 'monitor') {
      const btn = d.getElementById('btnMonitor');
      if (btn) btn.click();
      return;
    }
    // aplica um valor no filtro de status (ex.: ?click=instavel)
    if (state && d.getElementById('status')) {
      const sel = d.getElementById('status');
      if ([...sel.options].some((o) => o.value === state)) {
        sel.value = state;
        sel.dispatchEvent(new Event('change'));
        return;
      }
    }
    // abre o drawer: espera as linhas existirem (render e assincrono)
    if (ROW >= 0) {
      let tries = 0;
      const t = setInterval(() => {
        const rows = d.querySelectorAll('#rows tr');
        if (rows[ROW]) { rows[ROW].click(); clearInterval(t); }
        else if (++tries > 40) clearInterval(t);
      }, 150);
    }
  } catch (e) { /* ignora */ }
};
go();
</script></body></html>`);
        return;
      }

      // estaticos
      let filePath = route === '/' ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, route);
      if (!filePath.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
      if (!fs.existsSync(filePath)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const stamp = () => new Date().toISOString();
  console.log(`[${stamp()}] Monitor VoIP iniciado`);
  console.log(`[${stamp()}]   URL:   http://${host}:${port}`);
  console.log(`[${stamp()}]   Banco: ${path.resolve(dbPath)}`);
  console.log(`[${stamp()}]   Auth:  ${auth ? 'login (senha configurada)' : 'DESATIVADA'}`);

  const shutdown = (sig) => {
    console.log(`[${stamp()}] recebido ${sig}, encerrando...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}
