/**
 * Coleta SNMP de todas as impressoras cadastradas.
 *
 * Chamada pelo monitoramento (cron) ou manualmente. Grava o ESTADO ATUAL:
 * impressoras + consumiveis do ultimo estado. Nao acumula historico de
 * cada coleta — o banco antigo crescia 4 MB/dia por causa disso.
 *
 * CONCORRENCIA: testado com lotes de 4, 6, 12 e 128 impressoras. O numero
 * de falhas nao muda com a concorrencia — as impressoras que falham sao
 * sempre as mesmas (desligadas ou com SNMP desativado) ou tem resposta
 * intermitente propria. 12 e o ponto onde a coleta inteira cabe em ~30s
 * sem penalidade.
 *
 * Uso:
 *   node scripts/coletar-impressoras.mjs
 *   node scripts/coletar-impressoras.mjs --concorrencia 16 --timeout 4000
 */
import { openDb, fecharConexoes } from '../src/lib/db.js';
import { criarTabelasImpressoras, gravarVersaoImpressoras } from '../src/lib/impressoras-schema.js';
import { lerImpressora } from '../src/lib/impressoras-snmp.js';

const arg = (nome, padrao) => {
  const i = process.argv.indexOf('--' + nome);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
};

const CONCORRENCIA = Number(arg('concorrencia', 12));
const TIMEOUT = Number(arg('timeout', 3000));
const COMUNIDADE = arg('comunidade', process.env.SNMP_COMMUNITY || 'public');

const db = openDb(arg('db', 'voip.sqlite'));
criarTabelasImpressoras(db);
gravarVersaoImpressoras(db);

const alvos = db.prepare(`SELECT ip FROM impressoras WHERE ativo = 1 ORDER BY ip`).all().map((r) => r.ip);

if (!alvos.length) {
  console.log('nenhuma impressora cadastrada — rode scripts/importar-impressoras.mjs');
  fecharConexoes();
  process.exit(0);
}

const agora = new Date().toISOString();
const dia = agora.slice(0, 10);

const sqlOk = db.prepare(`
  UPDATE impressoras SET online = 1,
    serie = @serie,
    modelo = COALESCE(@modelo, modelo),
    apelido = COALESCE(@apelido, apelido),
    descricao = @descricao,
    paginas = @paginas, coletado_em = @agora
  WHERE ip = @ip
`);
const sqlFalha = db.prepare(`UPDATE impressoras SET online = 0, faltou_em = @agora WHERE ip = @ip`);
const sqlLimpaCons = db.prepare(`DELETE FROM impressora_consumiveis WHERE ip = ?`);
const sqlCons = db.prepare(`
  INSERT INTO impressora_consumiveis
    (ip, slot, nome, nominal, atual, percentual, part_number, serial)
  VALUES (@ip, @slot, @nome, @nominal, @atual, @percentual, @part_number, @serial)
`);
const sqlHist = db.prepare(`
  INSERT INTO impressora_historico (ip, dia, paginas, consumiveis) VALUES (@ip, @dia, @paginas, @consumiveis)
  ON CONFLICT(ip, dia) DO UPDATE SET paginas = excluded.paginas, consumiveis = excluded.consumiveis
`);

/**
 * Grava o resultado de uma impressora numa transacao curta.
 *
 * node:sqlite nao tem db.transaction() (isso e do better-sqlite3), entao a
 * transacao e explicita. Como as coletas rodam concorrentes, cada gravacao
 * precisa ser atomica: ou entra o estado novo inteiro, ou nada.
 */
function gravar(r) {
  db.exec('BEGIN IMMEDIATE');
  try {
    sqlOk.run({
      ip: r.ip, serie: r.serie, modelo: r.modelo, apelido: r.apelido,
      descricao: r.descricao, paginas: r.paginas, agora,
    });
    sqlLimpaCons.run(r.ip);
    const niveis = {};
    for (const c of r.consumiveis) {
      sqlCons.run({
        ip: r.ip, slot: c.slot, nome: c.nome, nominal: c.nominal, atual: c.atual,
        percentual: c.percentual, part_number: c.part_number, serial: c.serial,
      });
      if (c.percentual != null) niveis[c.slot] = c.percentual;
    }
    // historico: uma linha por dia (nao por coleta)
    sqlHist.run({ ip: r.ip, dia, paginas: r.paginas, consumiveis: JSON.stringify(niveis) });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const t0 = Date.now();
let ok = 0, falhas = 0, consumiveis = 0;
const semResposta = [];

/** Processa em lotes para nao abrir 103 sessoes SNMP de uma vez. */
async function emLotes(itens, tamanho, fn) {
  for (let i = 0; i < itens.length; i += tamanho) {
    await Promise.all(itens.slice(i, i + tamanho).map(fn));
  }
}

await emLotes(alvos, CONCORRENCIA, async (ip) => {
  const r = await lerImpressora(ip, { comunidade: COMUNIDADE, timeoutMs: TIMEOUT });
  if (!r) {
    falhas++;
    semResposta.push(ip);
    sqlFalha.run({ ip, agora });
    return;
  }
  ok++;
  consumiveis += r.consumiveis.length;
  gravar(r);
});

const ms = Date.now() - t0;

console.log(`\n=== coleta de impressoras ===`);
console.log(`  alvos        : ${alvos.length}`);
console.log(`  responderam  : ${ok}`);
console.log(`  sem resposta : ${falhas}${falhas ? '  (' + semResposta.slice(0, 8).join(', ') + (falhas > 8 ? '...' : '') + ')' : ''}`);
console.log(`  consumiveis  : ${consumiveis}`);
console.log(`  duracao      : ${(ms / 1000).toFixed(1)}s`);

if (falhas) {
  console.log(`\n  impressoras sem resposta (verificar se estao desligadas ou fora da rede):`);
  for (const ip of semResposta) {
    const d = db.prepare('SELECT setor, modelo FROM impressoras WHERE ip = ?').get(ip);
    console.log(`    ${ip.padEnd(15)} ${(d?.setor || '-').padEnd(28)} ${d?.modelo || ''}`);
  }
}

fecharConexoes();
