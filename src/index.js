#!/usr/bin/env node
/**
 * CLI do VoIP Scanner.
 *
 * Uso:
 *   node src/index.js scan [--targets 10.0.0.0/24] [--db voip.sqlite]
 *   node src/index.js report [--all] [--db voip.sqlite]
 *   node src/index.js export [--format csv|json] [--out arquivo]
 */
import fs from 'node:fs';
import path from 'node:path';
import { runScan, printTable } from './scan.js';
import { enrichPhones, printRamais } from './enrich.js';
import { openDb, listPhones, listDevices } from './lib/db.js';
import { DEFAULT_TARGETS, DEFAULTS } from './config.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const [, , command = 'scan', ...rest] = process.argv;
const args = parseArgs(rest);
const dbPath = args.db || DEFAULTS.dbPath;

/** Le web-config.json do diretorio de trabalho (nao versionado). */
function readWebConfig() {
  try {
    const p = path.resolve('web-config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`aviso: web-config.json invalido (${e.message}), usando padroes`);
  }
  return {};
}

async function main() {
  switch (command) {
    case 'scan': {
      const targets = args.targets
        ? String(args.targets).split(',').map((s) => s.trim()).filter(Boolean)
        : DEFAULT_TARGETS;
      const result = await runScan({
        targets,
        dbPath,
        hostConcurrency: args.concurrency ? Number(args.concurrency) : DEFAULTS.hostConcurrency,
        tcpTimeoutMs: args.timeout ? Number(args.timeout) : DEFAULTS.tcpTimeoutMs,
        probeSipEnabled: !args['no-sip'],
      });
      if (args.json) {
        fs.writeFileSync(args.json, JSON.stringify(
          result.phones.map((p) => ({
            ip: p.ip, mac: p.mac, vendor: p.vendor, sipServer: p.sipServer,
            sipUserAgent: p.sipUserAgent, httpServer: p.httpServer, ports: p.ports,
            deviceType: p.deviceType, confidence: p.confidence,
          })),
          null, 2,
        ));
        console.log(`\nJSON salvo em ${args.json}`);
      }
      break;
    }

    case 'enrich': {
      await enrichPhones({
        dbPath,
        concurrency: args.concurrency ? Number(args.concurrency) : 8,
        monitor: !!args.monitor,
        timeoutMs: args.timeout ? Number(args.timeout) : 4000,
        targets: args.targets ? String(args.targets).split(',').map((s) => s.trim()).filter(Boolean) : null,
      });
      break;
    }

    case 'ramais': {
      printRamais(dbPath);
      break;
    }

    case 'report': {
      const db = openDb(dbPath);
      const rows = args.all ? listDevices(db) : listPhones(db);
      console.log(`\n${args.all ? 'Todos os dispositivos' : 'Telefones VoIP'} (${rows.length}) — ${dbPath}\n`);
      printTable(rows);
      const scans = db.prepare(`SELECT id, started_at, state, hosts_scanned, hosts_alive, phones_found FROM scans ORDER BY id DESC LIMIT 10`).all();
      console.log('\nÚltimos scans:');
      for (const s of scans) {
        console.log(`  #${s.id}  ${s.started_at}  ${s.state}  hosts: ${s.hosts_alive}/${s.hosts_scanned}  phones: ${s.phones_found}`);
      }
      db.close();
      break;
    }

    case 'export': {
      const db = openDb(dbPath);
      const rows = args.all ? listDevices(db) : listPhones(db);
      const format = args.format || 'csv';
      const out = args.out || `voip-export.${format === 'json' ? 'json' : 'csv'}`;
      if (format === 'json') {
        fs.writeFileSync(out, JSON.stringify(rows, null, 2));
      } else {
        const fields = ['ip', 'ramal', 'model', 'firmware', 'serial', 'mac', 'hostname', 'vendor', 'device_type', 'confidence',
          'sip_ua', 'sip_server', 'sip_user_agent', 'sip_methods', 'ramal', 'firmware', 'serial',
          'http_server', 'http_title', 'ports_json', 'first_seen', 'last_seen', 'online']
          .filter((f, i, arr) => arr.indexOf(f) === i);
        const esc = (v) => {
          if (v == null) return '';
          const s = String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const lines = [fields.join(',')];
        for (const r of rows) lines.push(fields.map((f) => esc(r[f])).join(','));
        fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
      }
      console.log(`Exportado ${rows.length} registro(s) para ${out}`);
      db.close();
      break;
    }

    case 'web': {
      const { startWeb } = await import('./web/server.js');
      // precedencia: flag da CLI > web-config.json > padrao
      const conf = readWebConfig();
      await startWeb({
        dbPath,
        port: args.port ? Number(args.port) : Number(conf.port || 8080),
        host: args.host ? String(args.host) : String(conf.host || '127.0.0.1'),
        password: args.password || conf.password || undefined,
      });
      break;
    }

    case 'help':
    default: {
      console.log(`
VoIP Scanner

Comandos:
  scan      Varre a rede e grava no SQLite
  enrich    Descobre ramal/modelo/firmware via SIP (--monitor para ciclo de monitoramento)
  ramais    Lista ramal -> IP
  report    Mostra o inventário atual (--all para incluir não-telefones)
  export    Exporta CSV/JSON (--format csv|json --out arquivo)
  web       Sobe a interface web de monitoramento (--port 8080 --host 127.0.0.1 --password senha)

Opções do scan:
  --targets   alvos separados por vírgula (CIDR, range ou IP único)
              padrão: ${DEFAULT_TARGETS.join(',')}
  --db        caminho do SQLite (padrão: ${DEFAULTS.dbPath})
  --concurrency  hosts simultâneos (padrão: ${DEFAULTS.hostConcurrency})
  --timeout   timeout TCP por porta em ms (padrão: ${DEFAULTS.tcpTimeoutMs})
  --no-sip    desativa o probe SIP OPTIONS
  --json      salva também o resultado em JSON no caminho indicado

Exemplos:
  node src/index.js scan
  node src/index.js scan --targets 10.0.0.0/24 --concurrency 128
  node src/index.js report --all
  node src/index.js export --format csv --out telefones.csv
`);
    }
  }
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
