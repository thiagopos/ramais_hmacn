/**
 * Supervisor: mantem o servidor web no ar de forma independente.
 *
 * Diferente da tarefa agendada, este processo NAO sai: ele relança o servidor
 * sempre que o filho terminar, por qualquer motivo (crash, kill, exceção).
 * A tarefa agendada apenas garante que o supervisor suba no logon/boot.
 *
 * Uso: node scripts/supervisor.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG = path.join(LOG_DIR, 'supervisor.log');
const RUNNER = path.join(ROOT, 'scripts', 'run-server.mjs');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 2 * 1024 * 1024) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, line + '\n');
  } catch {
    // best effort
  }
}

let child = null;
let restarts = 0;
let stopping = false;
let startedAt = Date.now();

function launch() {
  if (stopping) return;
  startedAt = Date.now();
  child = spawn(process.execPath, [RUNNER], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
    detached: false,
  });
  log(`servidor iniciado (pid ${child.pid})`);

  child.on('exit', (code, signal) => {
    if (stopping) return;
    const uptime = Math.round((Date.now() - startedAt) / 1000);
    // se o servidor ficou de pe por >60s, considera que estava saudavel e zera backoff
    if (uptime > 60) restarts = 0;
    restarts++;
    const wait = Math.min(30000, 2000 * restarts);
    log(`servidor terminou (code=${code} signal=${signal}) apos ${uptime}s — relancando em ${wait / 1000}s`);
    setTimeout(launch, wait);
  });

  child.on('error', (err) => log(`erro ao iniciar servidor: ${err.message}`));
}

function shutdown(sig) {
  stopping = true;
  log(`supervisor recebeu ${sig}, encerrando servidor e saindo`);
  try { child?.kill('SIGTERM'); } catch {}
  setTimeout(() => process.exit(0), 2500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => log(`uncaughtException: ${e.message}`));

log('==== supervisor iniciado ====');
launch();
