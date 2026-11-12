/**
 * Runner do servidor web: sobe o servidor, registra log em arquivo e
 * reinicia automaticamente se cair. Usado pela tarefa agendada do Windows.
 *
 * Uso: node scripts/run-server.mjs [--port 8181] [--host 127.0.0.1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWeb } from '../src/web/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'server.log');

const MAX_LOG_BYTES = 5 * 1024 * 1024;

// referencia o stdout original ANTES de qualquer override (evita recursao)
const writeStdout = (...a) => process.stdout.write(a.map(String).join(' ') + '\n');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  writeStdout(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // log e best-effort
  }
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const port = Number(arg('port', process.env.VOIP_WEB_PORT || 8181));
const host = arg('host', process.env.VOIP_WEB_HOST || '127.0.0.1');
const dbPath = arg('db', path.join(ROOT, 'voip.sqlite'));
const password = arg('password', process.env.VOIP_WEB_PASS || undefined);

// Arquivo de config: permite trocar a senha sem editar a tarefa agendada
const CONF_FILE = path.join(ROOT, 'web-config.json');
let conf = {};
try {
  if (fs.existsSync(CONF_FILE)) conf = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
} catch (e) {
  log(`aviso: web-config.json invalido (${e.message}), usando padroes`);
}

const HOST = conf.host || host;
const PORT = Number(conf.port || port);
const PASSWORD = conf.password || password;

let attempt = 0;

async function start() {
  attempt++;
  try {
    log(`subindo servidor (tentativa ${attempt}) em http://${HOST}:${PORT}`);
    const server = await startWeb({ dbPath, port: PORT, host: HOST, password: PASSWORD });
    attempt = 0; // sucesso: reseta o backoff

    // supervisao do processo: se o servidor fechar sozinho, reabre.
    server.on('close', () => {
      log('servidor fechou inesperadamente, reabrindo...');
      setTimeout(start, 2000);
    });
  } catch (err) {
    const isInUse = err && err.code === 'EADDRINUSE';
    log(`FALHA: ${isInUse ? `porta ${PORT} ja esta em uso` : err.message}`);
    if (isInUse) {
      // outra instancia ja serve a porta: fica em espera em vez de sair,
      // para o supervisor nao criar um laco de relancamento.
      log('aguardando a porta liberar (retentativa em 30s)');
      setTimeout(start, 30000);
      return;
    }
    const wait = Math.min(30000, 3000 * attempt);
    log(`reiniciando em ${wait / 1000}s`);
    setTimeout(start, wait);
  }
}

process.on('uncaughtException', (err) => log(`uncaughtException: ${err.message}`));
process.on('unhandledRejection', (err) => log(`unhandledRejection: ${err?.message || err}`));

// captura o console.log do servidor no mesmo arquivo de log
console.log = (...args) => log('(server) ' + args.join(' '));
console.info = console.log;
console.error = (...args) => log('ERRO ' + args.join(' '));

log(`config: host=${HOST} porta=${PORT} auth=${PASSWORD ? 'senha definida' : 'DESATIVADA'}`);
start();
