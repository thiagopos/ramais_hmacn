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
import https from 'node:https';
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
  listarUsuarios, obterUsuario, salvarUsuario, removerUsuario, alternarUsuario,
  criarSessao, obterSessao, apagarSessao, marcarAcesso,
} from '../lib/db.js';
import { DEFAULT_TARGETS } from '../config.js';
import {
  SESSAO_HORAS, cookieLimpo, cookieSessao,
  gerarToken, paginaLogin, paginaNegado, tokenDaRequisicao, esc,
} from './auth.js';
import { autenticar, buscarUsuarios, buscarPorLogin } from './ldap.js';
import { carregarConfigAd } from '../../config/ad.js';
import {
  listarImpressoras, detalheImpressora, resumoImpressoras,
  setoresDasImpressoras, listarConsumiveis,
} from '../lib/impressoras-db.js';
import { criarTabelasImpressoras } from '../lib/impressoras-schema.js';
import {
  criarTabelasLocais, arvoreLocais, obterLocal, criarLocal, editarLocal, excluirLocal,
  vincularRamal, desvincularRamal, moverImpressora, ramaisDoLocal,
  impressorasDoLocal, descendentes,
} from '../lib/locais.js';

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

/**
 * Autenticacao por Active Directory + lista fechada de usuarios.
 *
 * Duas etapas independentes:
 *  1. o AD prova QUEM e a pessoa (bind com a senha digitada)
 *  2. a tabela `usuarios` decide se ela PODE entrar
 *
 * A senha existe apenas durante a requisicao; nada dela e gravado.
 */
function makeAuth({ dbPath, adConfig }) {
  /** Executa uma consulta com conexao propria e ja fecha. */
  const comDb = (fn) => {
    const db = openDb(dbPath);
    return fn(db);
  };

  /** IP de origem (respeita X-Forwarded-For se houver proxy na frente). */
  const ipDe = (req) => {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  };

  return {
    /**
     * Garante sessao valida. Trata /login (GET/POST) e /logout.
     * Retorna { tratado: true } quando a resposta ja foi enviada, ou
     * { usuario } quando a requisicao segue autenticada.
     */
    async handle(req, res, route) {
      if (route === '/logout') {
        const token = tokenDaRequisicao(req);
        if (token) comDb((db) => apagarSessao(db, token));
        res.writeHead(302, { 'Set-Cookie': cookieLimpo(), Location: '/login' });
        res.end();
        return { tratado: true };
      }

      const token = tokenDaRequisicao(req);
      const sessao = token ? comDb((db) => obterSessao(db, token)) : null;

      if (route === '/login' && req.method === 'GET') {
        if (sessao) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return { tratado: true };
        }
        const qs = new URL(req.url, 'http://local').searchParams;
        html(res, 200, paginaLogin({
          erro: qs.get('erro') || '',
          aviso: qs.get('aviso') || '',
          login: qs.get('u') || '',
        }));
        return { tratado: true };
      }

      if (route === '/login' && req.method === 'POST') {
        // limita o corpo: senha nao precisa de mais que isso
        const body = await readForm(req, 4096);
        const qs = new URLSearchParams(body);
        const login = (qs.get('username') || '').trim().toLowerCase();
        const senha = qs.get('password') || '';
        const vindoDe = ipDe(req);

        if (!login || !senha) {
          res.writeHead(302, { Location: '/login?erro=' + encodeURIComponent('Informe usuário e senha.') + '&u=' + encodeURIComponent(login) });
          res.end();
          return { tratado: true };
        }

        // 1) o AD valida a credencial
        const r = await autenticar(adConfig, login, senha);
        if (!r.ok) {
          console.log(`[auth] falha de login "${login}" de ${vindoDe}${r.conexao ? ' (AD indisponivel)' : ''}`);
          const msg = r.conexao
            ? 'Active Directory indisponível no momento. Tente novamente em instantes.'
            : 'Usuário ou senha inválidos.';
          res.writeHead(302, { Location: '/login?erro=' + encodeURIComponent(msg) + '&u=' + encodeURIComponent(login) });
          res.end();
          return { tratado: true };
        }

        // 2) credencial valida: o acesso depende do cadastro
        const usuario = comDb((db) => obterUsuario(db, login));
        if (!usuario) {
          console.log(`[auth] "${login}" autenticou no AD mas nao esta cadastrado (${vindoDe})`);
          html(res, 403, paginaNegado(
            'Sua conta do domínio foi validada, mas você não está cadastrado neste sistema. '
            + 'Solicite o cadastro à equipe de TI.',
          ));
          return { tratado: true };
        }
        if (!usuario.ativo) {
          console.log(`[auth] "${login}" esta desativado (${vindoDe})`);
          html(res, 403, paginaNegado('Seu acesso está desativado. Procure a equipe de TI.'));
          return { tratado: true };
        }

        const novoToken = gerarToken();
        comDb((db) => {
          criarSessao(db, {
            token: novoToken, login, ip: vindoDe,
            userAgent: req.headers['user-agent'] || null, horas: SESSAO_HORAS,
          });
          marcarAcesso(db, login);
        });
        console.log(`[auth] "${login}" entrou de ${vindoDe}`);

        res.writeHead(302, {
          'Set-Cookie': cookieSessao(novoToken),
          Location: '/',
        });
        res.end();
        return { tratado: true };
      }

      if (sessao) return { usuario: sessao.usuario };

      if (route.startsWith('/api/')) {
        json(req, res, 401, { error: 'nao autenticado' });
      } else {
        res.writeHead(302, { Location: '/login' });
        res.end();
      }
      return { tratado: true };
    },
  };
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

/** Resposta HTML (sempre sem cache: paginas de login/cadastro sao dinamicas). */
function html(res, code, corpo) {
  const raw = Buffer.from(corpo, 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': raw.length,
    'Cache-Control': 'no-store',
  });
  res.end(raw);
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

export async function startWeb({ dbPath = 'voip.sqlite', port = 8080, host = '127.0.0.1', ssl = null } = {}) {
  // garante schema
  const dbBoot = openDb(dbPath);
  // tabelas do modulo de impressoras (criadas na primeira abertura)
  criarTabelasImpressoras(dbBoot);
  criarTabelasLocais(dbBoot);

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

  // Autenticacao: sempre ativa (Active Directory + lista fechada de usuarios).
  const adConfig = carregarConfigAd(RAIZ);
  const auth = makeAuth({ dbPath, adConfig });

  // estado do monitoramento (compartilhado entre requisicoes e reidratavel)
  const mon = { running: false, startedAt: null, lastError: null, lastResult: null, promise: null };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = url.pathname;

    if (route !== '/__test') {
      const r = await auth.handle(req, res, route);
      if (r.tratado) return;
      // disponivel para as rotas (auditoria e tela de cadastro)
      req.usuario = r.usuario;
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

      // ---------------- locais (setores, sublocais e guarda-chuva) ----------------

      if (route === '/api/locais' && req.method === 'GET') {
        const db = openDb(dbPath);
        const rows = arvoreLocais(db);
        db.close();
        return json(req, res, 200, { rows });
      }

      if (route === '/api/locais' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const db = openDb(dbPath);
        const r = criarLocal(db, {
          nome: body.nome, tipo: body.tipo, paiId: body.paiId,
          andar: body.andar, predio: body.predio, ala: body.ala,
          origem: 'manual',
        });
        db.close();
        if (!r.ok) return json(req, res, 400, { ok: false, erro: r.erro });
        return json(req, res, 200, { ok: true, id: r.id });
      }

      // buscar ramais do AD/banco para vincular a um local
      if (route === '/api/locais/ramais-disponiveis' && req.method === 'GET') {
        const termo = (url.searchParams.get('q') || '').trim();
        const db = openDb(dbPath);
        const rows = db.prepare(`
          SELECT DISTINCT substr(d.ramal, 3) AS curto, d.ramal, d.ip, d.model,
                 (SELECT GROUP_CONCAT(l.nome, ' + ')
                    FROM local_ramais lr JOIN locais l ON l.id = lr.local_id
                   WHERE lr.ramal_curto = substr(d.ramal, 3)) AS setores
          FROM devices d
          WHERE d.is_phone = 1 AND d.ramal IS NOT NULL
            ${termo ? "AND (d.ramal LIKE ? OR substr(d.ramal,3) LIKE ?)" : ''}
          ORDER BY CAST(d.ramal AS INTEGER) LIMIT 40
        `).all(...(termo ? [`%${termo}%`, `%${termo}%`] : []));
        db.close();
        return json(req, res, 200, { rows });
      }

      if (route.startsWith('/api/locais/') && req.method === 'GET') {
        const id = Number(route.slice('/api/locais/'.length));
        const db = openDb(dbPath);
        const det = obterLocal(db, id);
        if (!det) { db.close(); return json(req, res, 404, { error: 'local nao encontrado' }); }
        const ramais = ramaisDoLocal(db, id);
        const imps = impressorasDoLocal(db, id);
        // totais do guarda-chuva (inclui descendentes)
        const subs = descendentes(db, id);
        let ramaisSub = 0, impsSub = 0;
        if (subs.length) {
          const marcas = subs.map(() => '?').join(',');
          ramaisSub = db.prepare(`SELECT COUNT(*) c FROM local_ramais WHERE local_id IN (${marcas})`).get(...subs).c;
          impsSub = db.prepare(`SELECT COUNT(*) c FROM impressoras WHERE local_id IN (${marcas})`).get(...subs).c;
        }
        db.close();
        return json(req, res, 200, {
          ...det,
          ramais, impressoras: imps,
          descendentes: subs.length,
          totais_arvore: { ramais: det.ramais + ramaisSub, impressoras: det.impressoras + impsSub },
        });
      }

      // ---- vinculos: precisam vir ANTES do /api/locais/:id generico,
      //      senao "298/ramais" seria interpretado como id ----

      // vinculo ramal <-> local
      if (route.match(/^\/api\/locais\/\d+\/ramais$/) && req.method === 'POST') {
        const id = Number(route.split('/')[3]);
        const body = await readJsonBody(req);
        const db = openDb(dbPath);
        const r = vincularRamal(db, { localId: id, ramalCurto: body.ramal });
        db.close();
        if (!r.ok) return json(req, res, 400, { ok: false, erro: r.erro });
        return json(req, res, 200, { ok: true });
      }

      if (route.match(/^\/api\/locais\/\d+\/ramais\/\w+$/) && req.method === 'DELETE') {
        const partes = route.split('/');
        const db = openDb(dbPath);
        const r = desvincularRamal(db, { localId: Number(partes[3]), ramalCurto: partes[5] });
        db.close();
        if (!r.ok) return json(req, res, 400, { ok: false, erro: r.erro });
        return json(req, res, 200, { ok: true });
      }

      // mover impressora para um local (localId null = deixar livre)
      if (route.match(/^\/api\/locais\/\d+\/impressoras$/) && req.method === 'POST') {
        const id = Number(route.split('/')[3]);
        const body = await readJsonBody(req);
        const db = openDb(dbPath);
        const r = moverImpressora(db, { ip: body.ip, localId: id });
        db.close();
        if (!r.ok) return json(req, res, 400, { ok: false, erro: r.erro });
        return json(req, res, 200, { ok: true });
      }

      if (route.startsWith('/api/locais/') && req.method === 'POST') {
        const id = Number(route.slice('/api/locais/'.length));
        if (!Number.isFinite(id) || id <= 0) return json(req, res, 400, { ok: false, erro: 'id inválido' });
        const body = await readJsonBody(req);
        const db = openDb(dbPath);
        const r = editarLocal(db, id, body);
        db.close();
        if (!r.ok) return json(req, res, 400, { ok: false, erro: r.erro });
        return json(req, res, 200, { ok: true });
      }

      if (route.startsWith('/api/locais/') && req.method === 'DELETE') {
        const id = Number(route.slice('/api/locais/'.length));
        const db = openDb(dbPath);
        const r = excluirLocal(db, id);
        db.close();
        if (!r.ok) return json(req, res, 400, { ok: false, erro: r.erro });
        return json(req, res, 200, { ok: true, soltos: r.soltos });
      }

      // ---------------- impressoras ----------------

      if (route === '/api/impressoras' && req.method === 'GET') {
        const db = openDb(dbPath);
        const rows = listarImpressoras(db);
        const setores = setoresDasImpressoras(db);
        const resumo = resumoImpressoras(db);
        db.close();
        return json(req, res, 200, { rows, setores, resumo });
      }

      if (route === '/api/impressoras/consumiveis' && req.method === 'GET') {
        const db = openDb(dbPath);
        const rows = listarConsumiveis(db);
        db.close();
        return json(req, res, 200, { rows });
      }

      // coleta sob demanda (mesma logica do script, em processo separado)
      if (route === '/api/impressoras/coletar' && req.method === 'POST') {
        if (mon.coletandoImpressoras) {
          return json(req, res, 409, { error: 'Já existe uma coleta de impressoras em andamento.' });
        }
        mon.coletandoImpressoras = true;
        mon.coletaIniciadaEm = new Date().toISOString();
        mon.erroColetaImpressoras = null;
        const t0 = Date.now();

        // o script grava o resumo em arquivo (stdio 'ignore': sem depender de pipe)
        const tmpResultado = path.join(os.tmpdir(), `impressoras-${process.pid}-${Date.now()}.json`);
        const filho = spawn(process.execPath, [
          path.join(RAIZ, 'scripts', 'coletar-impressoras.mjs'),
          '--db', path.resolve(dbPath),
          '--resultado', tmpResultado,
        ], { cwd: RAIZ, stdio: 'ignore', windowsHide: true });

        filho.on('error', (err) => {
          mon.coletandoImpressoras = false;
          mon.coletaIniciadaEm = null;
          mon.erroColetaImpressoras = err.message;
        });

        filho.on('exit', (code) => {
          mon.coletandoImpressoras = false;
          mon.coletaIniciadaEm = null;
          let resumo = null;
          try {
            if (fs.existsSync(tmpResultado)) {
              resumo = JSON.parse(fs.readFileSync(tmpResultado, 'utf8'));
              fs.unlinkSync(tmpResultado);
            }
          } catch { /* resumo ilegivel: segue com o essencial */ }

          if (code === 0 && resumo) {
            mon.ultimaColetaImpressoras = { ...resumo, duracaoMs: Date.now() - t0, terminouEm: new Date().toISOString() };
            console.log(`[impressoras] coleta: ${resumo.responderam}/${resumo.total} em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          } else if (code !== 0) {
            mon.erroColetaImpressoras = `a coleta terminou com codigo ${code}`;
            console.log(`[impressoras] coleta falhou (codigo ${code})`);
          }
        });
        return json(req, res, 202, { started: true, iniciadoEm: mon.coletaIniciadaEm });
      }

      if (route === '/api/impressoras/status' && req.method === 'GET') {
        return json(req, res, 200, {
          coletando: !!mon.coletandoImpressoras,
          iniciadoEm: mon.coletaIniciadaEm || null,
          ultimaColeta: mon.ultimaColetaImpressoras || null,
          erro: mon.erroColetaImpressoras || null,
        });
      }

      // detalhe de UMA impressora — por ultimo, para nao capturar /status e
      // /coletar antes delas (mesmo cuidado que a rota de locais exige)
      if (route.startsWith('/api/impressoras/') && req.method === 'GET') {
        const ip = decodeURIComponent(route.slice('/api/impressoras/'.length));
        const db = openDb(dbPath);
        const det = detalheImpressora(db, ip);
        db.close();
        if (!det) return json(req, res, 404, { error: 'impressora nao encontrada' });
        return json(req, res, 200, det);
      }

      if (route === '/api/scope' && req.method === 'GET') {
        const db = openDb(dbPath);
        const scopes = knownTargets(db);
        db.close();
        return json(req, res, 200, { targets: scopes.length ? scopes : DEFAULT_TARGETS });
      }

      // ---------------- usuarios autorizados ----------------

      // quem esta logado (a interface usa para montar o cabecalho)
      if (route === '/api/eu' && req.method === 'GET') {
        return json(req, res, 200, {
          login: req.usuario.login,
          nome: req.usuario.nome,
          email: req.usuario.email,
          departamento: req.usuario.departamento,
        });
      }

      if (route === '/api/usuarios' && req.method === 'GET') {
        const db = openDb(dbPath);
        const rows = listarUsuarios(db);
        db.close();
        return json(req, res, 200, { rows, eu: req.usuario.login });
      }

      // busca no AD para o cadastro (usa a conta de servico do .env)
      if (route === '/api/usuarios/buscar-ad' && req.method === 'GET') {
        const termo = (url.searchParams.get('q') || '').trim();
        try {
          const achados = await buscarUsuarios(adConfig, termo, 25);
          const db = openDb(dbPath);
          const cadastrados = new Set(db.prepare(`SELECT login FROM usuarios`).all().map((r) => r.login));
          db.close();
          return json(req, res, 200, {
            rows: achados.map((u) => ({ ...u, jaCadastrado: cadastrados.has(u.login.toLowerCase()) })),
          });
        } catch (err) {
          return json(req, res, 502, { error: err.message });
        }
      }

      /**
       * Busca UM usuario pelo login exato — comportamento do hmacn-acesso.
       *
       * Devolve tambem `local`: o cadastro que ja existe neste sistema. O AD
       * responde "quem e a pessoa"; o `local` responde "ja tem cadastro aqui".
       * Sem isso a tela so descobriria no envio, com o formulario ja preenchido.
       */
      if (route.startsWith('/api/usuarios/ad/') && req.method === 'GET') {
        const login = decodeURIComponent(route.slice('/api/usuarios/ad/'.length)).trim();
        if (!login) return json(req, res, 200, { encontrado: false });

        // falha ao ler o banco nao derruba a busca no AD (so perde o aviso)
        let local = { existe: false };
        try {
          const db = openDb(dbPath);
          const u = obterUsuario(db, login);
          db.close();
          if (u) {
            local = {
              existe: true, login: u.login, nome: u.nome, email: u.email,
              departamento: u.departamento, cargo: u.cargo, ativo: !!u.ativo,
            };
          }
        } catch { /* segue sem o local */ }

        const r = await buscarPorLogin(adConfig, login);
        if (r.erro) {
          console.warn(`[ad] busca por login "${login}": ${r.erro}`);
          return json(req, res, 502, { encontrado: false, local, erro: r.erro });
        }
        if (!r.encontrado) return json(req, res, 200, { encontrado: false, local });
        return json(req, res, 200, { encontrado: true, pessoa: r.pessoa, local });
      }

      if (route === '/api/usuarios' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const db = openDb(dbPath);
        const r = salvarUsuario(db, {
          login: body.login,
          nome: body.nome,
          email: body.email,
          departamento: body.departamento,
          cargo: body.cargo,
          criadoPor: req.usuario.login,
        });
        db.close();
        if (!r.ok) return json(req, res, 400, { ok: false, erro: r.erro });
        return json(req, res, 200, { ok: true, criado: r.criado });
      }

      // ativar/desativar ou remover: /api/usuarios/:login
      if (route.startsWith('/api/usuarios/') && (req.method === 'POST' || req.method === 'DELETE')) {
        const login = decodeURIComponent(route.slice('/api/usuarios/'.length));
        const alvo = login.toLowerCase();

        // protecao: nao deixar o sistema sem administradores
        const db = openDb(dbPath);
        if (alvo === req.usuario.login.toLowerCase() && req.method === 'DELETE') {
          db.close();
          return json(req, res, 400, { ok: false, erro: 'Você não pode remover seu próprio acesso.' });
        }

        let r;
        if (req.method === 'DELETE') {
          r = removerUsuario(db, alvo, req.usuario.login);
        } else {
          const body = await readJsonBody(req);
          r = alternarUsuario(db, alvo, !!body.ativo, req.usuario.login);
        }
        db.close();

        if (!r.ok) return json(req, res, 400, { ok: false, erro: r.erro });
        return json(req, res, 200, { ok: true });
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
        // credenciais do AD para o harness (apenas de localhost).
        // Usuario e senha vem da query e so existem durante este teste visual.
        const usuarioAd = url.searchParams.get('u') || '';
        const senhaAd = url.searchParams.get('p') || '';
        // pagina a abrir dentro do iframe (padrao: raiz)
        const pagina = url.searchParams.get('pagina') || '/';
        const cfg = JSON.stringify({ row: n, click, filtro, u: usuarioAd, p: senhaAd, pagina });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!DOCTYPE html><html><body style="margin:0">
<iframe id="f" style="width:100vw;height:${altura}px;border:0;display:block"></iframe>
<script>
const CFG = ${cfg};
const f = document.getElementById('f');
async function go() {
  const st = await fetch("/api/eu", { credentials: "same-origin" });
  if (st.status !== 200 && CFG.u && CFG.p) {
    await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=" + encodeURIComponent(CFG.u) + "&password=" + encodeURIComponent(CFG.p),
      credentials: "same-origin",
      redirect: "manual",
    }).catch(function () {});
  }
  f.src = (CFG.pagina || "/") + "?t=" + Date.now() + CFG.filtro;
}
f.onload = function () {
  try {
    const d = f.contentDocument;
    const state = CFG.click;
    // sem ?row= so executa a acao pedida em ?click= (ex.: ordenar uma coluna
    // ou abrir o gerenciamento de usuarios); com row, abre o painel lateral
    if (CFG.row < 0 && !state) return;
    let tries = 0;
    const t = setInterval(function () {
      const rows = d.querySelectorAll('#rows tr');
      // espera a tabela popular antes de agir (o iframe carrega antes dos dados)
      if (!rows.length || (CFG.row >= 0 && !rows[CFG.row])) {
        if (++tries <= 60) return;
        clearInterval(t);
        return;
      }
      clearInterval(t);
      if (CFG.row >= 0) rows[CFG.row].click();
      {
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
        // abre o gerenciamento de usuarios (?click=usuarios)
        if (state === "usuarios") {
          if (typeof d.defaultView.usAbrir === "function") d.defaultView.usAbrir();
        }
        // ordena por uma coluna (?click=col:quedas ou col:quedas:2)
        if (state.indexOf("col:") === 0) {
          const p = state.split(":");
          const th = d.querySelector('th[data-k="' + p[1] + '"]');
          if (th) {
            th.click();
            if (p[2] === "2") setTimeout(function () { th.click(); }, 300);
          }
        }
      }
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
  console.log(`[${stamp()}]   Auth:  login pelo Active Directory`);

  // -------------------------------------------------------------------
  // HTTPS em paralelo (o mesmo handler atende os dois protocolos).
  //
  // Mantemos o HTTP porque o endereco http://host:porta ja esta em uso e
  // porque a porta 443 desta maquina pertence ao sistema de visitantes.
  // O certificado e o mesmo usado nas outras aplicacoes do hospital:
  // CA local + certificado de servidor (nunca autoassinado — o Firefox
  // recusa certificado de CA usado como servidor).
  // -------------------------------------------------------------------
  let servidorHttps = null;
  const certPath = ssl?.cert ? (path.isAbsolute(ssl.cert) ? ssl.cert : path.join(RAIZ, ssl.cert)) : null;
  const keyPath = ssl?.key ? (path.isAbsolute(ssl.key) ? ssl.key : path.join(RAIZ, ssl.key)) : null;

  if (certPath && keyPath) {
    try {
      const cert = fs.readFileSync(certPath);
      const key = fs.readFileSync(keyPath);
      servidorHttps = https.createServer({ cert, key }, server.listeners('request')[0]);
      await new Promise((resolve, reject) => {
        servidorHttps.once('error', reject);
        servidorHttps.listen(ssl.port, host, resolve);
      });
      console.log(`[${stamp()}]   HTTPS: https://${host}:${ssl.port}  (${path.basename(certPath)})`);
    } catch (err) {
      // HTTPS e desejavel, nao obrigatorio: sem ele a interface continua em HTTP
      console.warn(`[${stamp()}]   HTTPS indisponivel: ${err.message}`);
      servidorHttps = null;
    }
  } else {
    console.log(`[${stamp()}]   HTTPS: desativado (defina ssl.cert e ssl.key em web-config.json)`);
  }

  const shutdown = (sig) => {
    console.log(`[${stamp()}] recebido ${sig}, encerrando...`);
    if (servidorHttps) {
      try { servidorHttps.close(); } catch { /* ignora */ }
    }
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
