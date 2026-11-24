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
      // 6 em 6 minutos: 240 ciclos/dia. A varredura leva ~3,6s para os 768
      // IPs, entao o intervalo e folgado — nao ha risco de um ciclo pegar o
      // anterior rodando.
      cron_restart: '*/6 * * * *',
      time: true,
      env: {
        NODE_ENV: 'production',
        NODE_NO_WARNINGS: '1',
      },
    },
    {
      // Coleta SNMP das impressoras. Cron proprio porque a leitura e mais
      // lenta (~21s para 103 impressoras) e nao pode competir com a
      // varredura de telefones.
      //
      // Sem este app, a coleta so acontece quando alguem clica em
      // "Coletar impressoras": o painel fica mostrando dado de dias atras.
      name: 'impressoras-monitor',
      namespace: 'default',
      script: 'scripts/coletar-impressoras.mjs',
      args: '',
      cwd: __dirname,
      exec_mode: 'fork_mode',
      instances: 1,
      // tarefa pontual: roda, termina e espera o proximo ciclo do cron
      autorestart: false,
      // 12 em 12 minutos: 120 ciclos/dia
      cron_restart: '*/12 * * * *',
      time: true,
      env: {
        NODE_ENV: 'production',
        NODE_NO_WARNINGS: '1',
      },
    },
  ],
};
