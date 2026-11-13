/**
 * Configuracao PM2 do monitor VoIP.
 *
 * Uso:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * Dois apps:
 *  - voip-web    : servidor web + API. PM2 cuida de restart e log.
 *  - voip-monitor: varredura de 1 em 1 hora via cron_restart, com
 *                  autorestart:false (roda, termina e fica parado ate o
 *                  proximo ciclo) — mesmo padrao do hmacn-acesso-backup.
 *
 * A senha e a porta ficam em web-config.json (nao versionado).
 */
module.exports = {
  apps: [
    {
      name: 'voip-web',
      namespace: 'default',
      script: 'src/index.js',
      args: 'web',
      cwd: __dirname,
      exec_mode: 'fork_mode',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '300M',
      kill_timeout: 8000,
      listen_timeout: 15000,
      time: true,
      env: {
        NODE_ENV: 'production',
        NODE_NO_WARNINGS: '1',
      },
    },
    {
      name: 'voip-monitor',
      namespace: 'default',
      script: 'src/index.js',
      args: 'enrich --monitor',
      cwd: __dirname,
      exec_mode: 'fork_mode',
      instances: 1,
      // tarefa pontual: executa e termina; o PM2 acorda de novo no cron
      autorestart: false,
      cron_restart: '0 * * * *',
      time: true,
      env: {
        NODE_ENV: 'production',
        NODE_NO_WARNINGS: '1',
      },
    },
  ],
};
