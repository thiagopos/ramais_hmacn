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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  openDb, inventoryRows, knownTargets, setoresResumo, estabilidadeResumo,
  listarSetores, setoresDoRamal, vincularSetor, desvincularSetor, editarSetor,
  listarQuedas, resumoQuedas, inventarioDetalhe, fecharConexoes,
  statsProntas, refreshStats,
} from '../lib/db.js';
import { DEFAULT_TARGETS } from '../config.js';
import {
  LOGIN_PAGE, SESSION_COOKIE_NAME, checkPassword, clearSessionCookie,
  parseCookies, sessionToken,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
/** Raiz do projeto: usada para disparar a varredura em processo filho. */
const RAIZ = path.resolve(__dirname, '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * Resposta JSON com compressao e revalidacao por ETag.
 *
 * - gzip quando o cliente aceita e o corpo passa de 1 KB
 * - ETag forte (sha1 do corpo + encoding): o navegador revalida e recebe
 *   304 sem corpo quando nada mudou
 * - Cache-Control: no-cache permite guardar, mas obriga revalidar
 *   (o dado muda a cada ciclo de monitoramento, nunca servimos velho)
 */
function json(req, res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  sendBody(req, res, code, body, 'application/json; charset=utf-8');
}

/** Envia um corpo aplicando gzip + ETag/304. */
function sendBody(req, res, code, rawBody, contentType, { maxAge = null } = {}) {
  const aceitaGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const comprime = aceitaGzip && rawBody.length >= 1024;

  let body = rawBody;
  const headers = {
    'Content-Type': contentType,
    Vary: 'Accept-Encoding',
  };

  if (comprime) {
    body = zlib.gzipSync(rawBody, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
  }

  // ETag inclui o encoding: o mesmo recurso comprimido e sem comprimir tem tags distintas
  headers.ETag = `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 27)}"`;
  headers['Cache-Control'] = maxAge == null ? 'no-cache' : `public, max-age=${maxAge}`;

  // revalidacao: se o cliente ja tem esta versao, 304 sem corpo
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').map((s) => s.trim()).includes(headers.ETag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  headers['Content-Length'] = body.length;
  res.writeHead(code, headers);
  res.end(body);
}

/** Arquivo estatico: gzip + ETag por conteudo + revalidacao. */
function sendFile(req, res, filePath) {
  const ext = path.extname(filePath);
  const tipo = MIME[ext] || 'application/octet-stream';
  const raw = fs.readFileSync(filePath);
  sendBody(req, res, 200, raw, tipo, { maxAge: 0 });
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
        json(req, res, 401, { error: 'nao autenticado' });
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

/** Le corpo JSON (limitado). Retorna {} se vazio/invalido. */
async function readJsonBody(req, limit = 64 * 1024) {
  const raw = await readForm(req, limit);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

export async function startWeb({ dbPath = 'voip.sqlite', port = 8080, host = '127.0.0.1', password } = {}) {
  // garante schema
  const dbBoot = openDb(dbPath);

  // Cache materializado vazio (banco restaurado de backup ou primeiro uso):
  // constroi agora, senao a interface mostraria tudo zerado ate o proximo
  // ciclo de monitoramento. Custa ~0,9s UMA vez, no startup.
  if (!statsProntas(dbBoot)) {
    const amostras = dbBoot.prepare('SELECT COUNT(*) c FROM monitor_samples').get().c;
    if (amostras > 0) {
      const t0 = Date.now();
      const r = refreshStats(dbBoot);
      console.log(`[${new Date().toISOString()}] cache de estatisticas reconstruido: ` +
        `${r.devices} dispositivos, ${r.episodios} episodios em ${Date.now() - t0} ms`);
    }
  }

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
      // ficha completa de um aparelho (carregada ao abrir o painel lateral)
      if (route.startsWith('/api/phones/') && req.method === 'GET') {
        const ip = decodeURIComponent(route.slice('/api/phones/'.length));
        const db = openDb(dbPath);
        const det = inventarioDetalhe(db, ip);
        const setores = det ? setoresDoRamal(db, det.ramal) : [];
        db.close();
        if (!det) return json(req, res, 404, { error: 'aparelho nao encontrado' });
        return json(req, res, 200, { ...det, setores_vinculados: setores });
      }

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
        return json(req, res, 200, { count: rows.length, rows, setores });
      }

      if (route === '/api/setores' && req.method === 'GET') {
        const db = openDb(dbPath);
        const rows = setoresResumo(db);
        db.close();
        return json(req, res, 200, { count: rows.length, rows });
      }

      // ---- edicao de setores ----

      // catalogo completo (para o seletor da interface)
      if (route === '/api/setores/catalogo' && req.method === 'GET') {
        const db = openDb(dbPath);
        const rows = listarSetores(db);
        db.close();
        return json(req, res, 200, { rows });
      }

      // setores vinculados a um ramal
      if (route.startsWith('/api/ramais/') && route.endsWith('/setores') && req.method === 'GET') {
        const ramal = decodeURIComponent(route.slice('/api/ramais/'.length, -'/setores'.length));
        const db = openDb(dbPath);
        const rows = setoresDoRamal(db, ramal);
        db.close();
        return json(req, res, 200, { ramal, rows });
      }

      // vincula (existente ou novo setor)
      if (route === '/api/ramais/vincular' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const db = openDb(dbPath);
        const r = vincularSetor(db, { ...body, fonte: 'manual' });
        db.close();
        if (!r.ok) return json(req, res, 400, { ok: false, erro: r.erro });
        return json(req, res, 200, { ok: true, ...r });
      }

      // remove vinculo
      if (route === '/api/ramais/desvincular' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const db = openDb(dbPath);
        const r = desvincularSetor(db, body);
        db.close();
        if (!r.ok) return json(req, res, 400, { ok: false, erro: r.erro });
        return json(req, res, 200, { ok: true });
      }

      // edita os dados de um setor (nome/andar/predio/ala)
      if (route === '/api/setores/editar' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const db = openDb(dbPath);
        const r = editarSetor(db, body);
        db.close();
        if (!r.ok) return json(req, res, 400, { ok: false, erro: r.erro });
        return json(req, res, 200, { ok: true, semMudanca: r.semMudanca });
      }

      // ---- historico de quedas (episodios) ----
      if (route === '/api/quedas' && req.method === 'GET') {
        const ip = url.searchParams.get('ip') || null;
        const horas = url.searchParams.get('horas') ? Number(url.searchParams.get('horas')) : null;
        const db = openDb(dbPath);
        const rows = listarQuedas(db, { ip, horas });
        const resumo = ip ? resumoQuedas(db, ip) : null;
        db.close();
        return json(req, res, 200, { count: rows.length, rows, resumo });
      }

      if (route === '/api/stats' && req.method === 'GET') {
        const db = openDb(dbPath);
        const one = (sql) => db.prepare(sql).get();
        const stats = {
          total: one(`SELECT COUNT(*) c FROM devices WHERE is_phone=1`).c,
          online: one(`SELECT COUNT(*) c FROM devices WHERE is_phone=1 AND online=1`).c,
          // offline = estava no inventario e nao respondeu na ultima coleta
          desaparecidos: one(`SELECT COUNT(*) c FROM devices WHERE is_phone=1 AND online=0`).c,
          offline: one(`SELECT COUNT(*) c FROM devices WHERE is_phone=1 AND online=0`).c,
          nuncaVerificados: one(`SELECT COUNT(*) c FROM devices WHERE is_phone=1 AND online IS NULL`).c,
          comRamal: one(`SELECT COUNT(*) c FROM devices WHERE is_phone=1 AND ramal IS NOT NULL`).c,
          modelos: db.prepare(`SELECT model, COUNT(*) c FROM devices WHERE is_phone=1 GROUP BY model ORDER BY c DESC`).all(),
          firmwares: db.prepare(`SELECT firmware, COUNT(*) c FROM devices WHERE is_phone=1 AND firmware IS NOT NULL GROUP BY firmware ORDER BY c DESC`).all(),
          ultimoCheck: one(`SELECT finished_at FROM monitor_runs ORDER BY id DESC LIMIT 1`)?.finished_at || null,
          estabilidade: estabilidadeResumo(db),
          quedasAbertas: one(`SELECT COUNT(*) c FROM drop_episodes WHERE retorno IS NULL`).c,
          ultimoScan: db.prepare(`SELECT finished_at, hosts_alive, phones_found FROM scans WHERE targets NOT LIKE '%monitor%' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`).get() || null,
        };
        db.close();
        return json(req, res, 200, stats);
      }

      if (route === '/api/desaparecidos' && req.method === 'GET') {
        const db = openDb(dbPath);
        const rows = db.prepare(
          `SELECT ip, ramal, mac, model, last_seen, missing_since
           FROM devices WHERE is_phone=1 AND online=0 ORDER BY missing_since DESC`,
        ).all();
        db.close();
        return json(req, res, 200, { count: rows.length, rows });
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
        return json(req, res, 200, { events: rows });
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

        // Intervalo tipico entre ciclos.
        // Mediana simples nao serve: execucoes manuais geram intervalos curtos
        // (0-4 min) que contaminam a amostra. Usamos a MEDIA PONDERADA pela
        // proximidade dos intervalos previstos na configuracao do cron.
        const runs = db.prepare(`SELECT started_at FROM monitor_runs ORDER BY id DESC LIMIT 60`).all();
        const CANDIDATOS = [5, 10, 15, 20, 30, 45, 60, 120, 180, 360, 720, 1440];
        let step = 1;
        if (runs.length >= 4) {
          const gaps = [];
          for (let i = 0; i < runs.length - 1; i++) {
            const g = (new Date(runs[i].started_at) - new Date(runs[i + 1].started_at)) / 60000;
            if (g >= 4) gaps.push(g); // ignora tudo abaixo de 4 min (manual/retry)
          }
          // vota: cada intervalo sustenta os candidatos que estao a +-30% dele
          const votos = new Map(CANDIDATOS.map((c) => [c, 0]));
          for (const g of gaps) {
            for (const c of CANDIDATOS) {
              const erro = Math.abs(g - c) / c;
              if (erro <= 0.3) votos.set(c, votos.get(c) + (1 - erro));
            }
          }
          let melhor = null;
          for (const [c, v] of votos) if (melhor === null || v > votos.get(melhor)) melhor = c;
          if (melhor && votos.get(melhor) > 0) step = melhor / 60;
        }
        db.close();

        // esperado = quantas coletas cabem na janela (~1 por ciclo)
        const expected = Math.max(1, Math.floor(hours / step));

        return json(req, res, 200, {
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
        return json(req, res, 200, { runs: rows });
      }

      // estado atual do monitoramento (a UI consulta ao abrir/recarregar)
      if (route === '/api/monitor/status' && req.method === 'GET') {
        return json(req, res, 200, {
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
          return json(req, res, 409, {
            error: 'Já existe um monitoramento em andamento.',
            running: true,
            startedAt: mon.startedAt,
          });
        }
        mon.running = true;
        mon.startedAt = new Date().toISOString();
        mon.lastError = null;
        mon.progresso = null;

        // Roda em PROCESSO SEPARADO.
        // O recalculo do cache de estatisticas e sincrono (~0,5-1,2s) e
        // travaria o event loop, congelando a interface de todos os
        // usuarios. Como filho, o servidor segue respondendo em ~2ms.
        // O resultado volta por arquivo temporario (stdio fica 'ignore'
        // para nao depender de pipe, que e bloqueado em alguns ambientes).
        const tmpResultado = path.join(os.tmpdir(), `voip-monitor-${process.pid}-${Date.now()}.json`);
        const filho = spawn(process.execPath, [
          path.join(RAIZ, 'src', 'index.js'),
          'enrich', '--monitor',
          '--result-file', tmpResultado,
          '--db', path.resolve(dbPath),
        ], {
          cwd: RAIZ,
          stdio: 'ignore',
          windowsHide: true,
        });

        filho.on('error', (err) => {
          mon.lastError = { at: new Date().toISOString(), message: err.message };
          mon.running = false;
          mon.startedAt = null;
        });

        filho.on('exit', (code) => {
          mon.running = false;
          mon.startedAt = null;
          let r = null;
          try {
            if (fs.existsSync(tmpResultado)) {
              r = JSON.parse(fs.readFileSync(tmpResultado, 'utf8'));
              fs.unlinkSync(tmpResultado);
            }
          } catch { /* resultado ilegivel: ignora */ }

          if (code === 0 && r) {
            mon.lastResult = { finishedAt: new Date().toISOString(), ...r };
          } else if (code !== 0) {
            mon.lastError = { at: new Date().toISOString(), message: `a varredura terminou com codigo ${code}` };
            console.log(`[monitor] filho terminou com codigo ${code}`);
          }
        });

        // resposta imediata: a UI acompanha por /api/monitor/status
        return json(req, res, 202, { started: true, startedAt: mon.startedAt });
      }

      if (route === '/api/scope' && req.method === 'GET') {
        const db = openDb(dbPath);
        const scopes = knownTargets(db);
        db.close();
        return json(req, res, 200, { targets: scopes.length ? scopes : DEFAULT_TARGETS });
      }

      // harness de teste visual: SO de localhost (contornaria o login)
      if (route === '/__test') {
        const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (remote !== '127.0.0.1' && remote !== '::1') return json(req, res, 404, { error: 'not found' });
        const n = Number(url.searchParams.get('row') ?? -1);
        const click = url.searchParams.get('click') || '';
        // filtros repassados ao iframe: ?filtro=status%3Doffline
        const filtro = url.searchParams.get('filtro') ? '&' + url.searchParams.get('filtro') : '';
        const altura = Number(url.searchParams.get('h') || 880);
        const cfg = JSON.stringify({ row: n, click, pw: pw || '', filtro });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!DOCTYPE html><html><body style="margin:0">
<iframe id="f" style="width:1600px;height:${altura}px;border:0"></iframe>
<script>
const CFG = ${cfg};
const f = document.getElementById('f');
async function go() {
  const st = await fetch("/api/stats", { credentials: "same-origin" });
  if (st.status !== 200) {
    await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=" + encodeURIComponent(CFG.pw),
      credentials: "same-origin",
      redirect: "manual",
    }).catch(function () {});
  }
  f.src = "/?t=" + Date.now() + CFG.filtro;
}
f.onload = function () {
  try {
    const d = f.contentDocument;
    const state = CFG.click;
    if (CFG.row < 0) return;
    let tries = 0;
    const t = setInterval(function () {
      const rows = d.querySelectorAll('#rows tr');
      if (rows[CFG.row]) {
        rows[CFG.row].click();
        clearInterval(t);
        const sel = d.getElementById("status");
        if (state && sel && Array.from(sel.options).some(function (o) { return o.value === state; })) {
          sel.value = state;
          sel.dispatchEvent(new Event("change"));
        }
        const btn = state ? d.querySelector('#rangeSel button[data-h="' + state + '"]') : null;
        if (btn) {
          btn.click();
          Array.from(d.querySelectorAll("#rangeSel button")).forEach(function (x) { x.classList.remove("active"); });
          btn.classList.add("active");
        }
        // abre o modal de setores (?click=modal | modal-novo | modal-edit)
        if (state === "modal" || state === "modal-novo" || state === "modal-edit") {
          const eb = d.getElementById("btnEditSetor");
          if (eb) {
            eb.click();
            if (state === "modal-novo") {
              setTimeout(function () {
                const tab = d.querySelector('.sm-tab[data-tab="novo"]');
                if (tab) tab.click();
              }, 700);
            }
            if (state === "modal-edit") {
              setTimeout(function () {
                const p = d.querySelector('.sm-tag button[data-edit]');
                if (p) p.click();
              }, 900);
            }
          }
        }
        // abre o historico de quedas (?click=quedas)
        if (state === "quedas") {
          const qb = d.getElementById("btnQuedas");
          if (qb) qb.click();
        }
      } else if (++tries > 40) clearInterval(t);
    }, 150);
  } catch (e) { /* ignora */ }
};
go();
</script></body></html>`);
        return;
      }

      // estaticos
      let filePath = route === '/' ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, route);
      if (!filePath.startsWith(PUBLIC)) return json(req, res, 403, { error: 'forbidden' });
      if (!fs.existsSync(filePath)) return json(req, res, 404, { error: 'not found' });
      return sendFile(req, res, filePath);
    } catch (err) {
      json(req, res, 500, { error: err.message });
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
    server.close(() => {
      try { fecharConexoes(); } catch { /* ignora */ }
      process.exit(0);
    });
    setTimeout(() => {
      try { fecharConexoes(); } catch { /* ignora */ }
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}
