/**
 * Semeia o primeiro administrador.
 *
 * Roda uma vez (ou sempre que a tabela estiver vazia) e cadastra o usuario
 * inicial. Nao grava senha: o login continua sendo validado pelo AD.
 *
 * Uso: node scripts/semear-admin.mjs [login]
 */
import { openDb, salvarUsuario, obterUsuario, contarUsuariosAtivos, fecharConexoes } from '../src/lib/db.js';

const dbPath = process.argv[3] || 'voip.sqlite';
const login = (process.argv[2] || 'x344942').toLowerCase();

const db = openDb(dbPath);
const ativos = contarUsuariosAtivos(db);

if (ativos > 0 && obterUsuario(db, login)) {
  console.log(`ja existe acesso para "${login}" — nada a fazer.`);
  console.log(`usuarios ativos: ${ativos}`);
  fecharConexoes();
  process.exit(0);
}

const r = salvarUsuario(db, {
  login,
  nome: 'Thiago Gomes Possa',
  email: 'thiagopossa@prefeitura.sp.gov.br',
  departamento: 'DIT',
  cargo: 'Analista de TI',
  criadoPor: 'semeadura',
});

console.log(r.ok ? `administrador "${login}" cadastrado.` : `falha: ${r.erro}`);
console.log(`usuarios ativos agora: ${contarUsuariosAtivos(db)}`);
fecharConexoes();
