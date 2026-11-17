/**
 * Reconstroi as tabelas materializadas (device_stats, drop_episodes).
 *
 * Uso:
 *   node scripts/rebuild-stats.mjs            # no banco padrao
 *   node scripts/rebuild-stats.mjs outro.sqlite
 *
 * Roda automaticamente ao final de cada monitoramento; este script serve
 * para migracao inicial, correcao manual ou apos alterar a regra da view.
 */
import { openDb, refreshStats, statsProntas, getMeta } from '../src/lib/db.js';

const dbPath = process.argv[2] || 'voip.sqlite';

const db = openDb(dbPath);
const amostras = db.prepare('SELECT COUNT(*) c FROM monitor_samples').get().c;
const antes = statsProntas(db);

console.log(`banco: ${dbPath}`);
console.log(`amostras: ${amostras.toLocaleString('pt-BR')}`);
console.log(`cache existente: ${antes ? 'sim (' + getMeta(db, 'stats_at') + ')' : 'nao'}`);
console.log('\nrecalculando...');

const r = refreshStats(db);
db.close();

console.log(`\nok: ${r.devices} dispositivos, ${r.episodios} episodios em ${r.ms} ms`);
