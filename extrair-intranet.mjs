import fs from 'node:fs';
const html = fs.readFileSync('intranet-ramais.html', 'utf8');

const ANDAR_NOME = {
  myUL: 'Térreo', myUL1: '1º Andar', myUL2: '2º Andar', myUL3: '3º Andar',
  myUL4: '4º Andar', myUL5: '5º Andar', myUL6: '6º Andar',
};

const uls = [...html.matchAll(/<ul[^>]*id="(myUL\d*)"[^>]*>([\s\S]*?)<\/ul>/gi)];
const registros = [];
const semRamal = [];

for (const [, id, conteudo] of uls) {
  const andar = ANDAR_NOME[id] || id;
  const lis = [...conteudo.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)];
  for (const l of lis) {
    const bruto = l[1];
    const dd = (bruto.match(/<dd[^>]*>([\s\S]*?)<\/dd>/i) || [])[1] || '';
    const p = (bruto.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
    const limpa = (s) => s
      .replace(/&emsp;|&#8195;/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const ramal = limpa(dd);
    // remove o prefixo do icone/texto "Phone"
    const setor = limpa(p).replace(/^(Phone|Telefone|\u260E)\s*/i, '').trim();

    if (!/^\d{4}$/.test(ramal)) {
      if (ramal || setor) semRamal.push({ andar, ramal, setor });
      continue;
    }
    registros.push({ andar, ramal, setor });
  }
}

fs.writeFileSync('intranet-ramais.json', JSON.stringify(registros, null, 2), 'utf8');

console.log('=== RESUMO ===');
console.log('registros com ramal:', registros.length);
console.log('itens sem ramal valido:', semRamal.length);
const porAndar = {};
for (const r of registros) porAndar[r.andar] = (porAndar[r.andar] || 0) + 1;
console.log('por andar:', JSON.stringify(porAndar));
const ramaisUnicos = new Set(registros.map((r) => r.ramal));
console.log('ramais unicos:', ramaisUnicos.size);

console.log('\n=== amostra ===');
for (const r of registros.slice(0, 8)) console.log(` ${r.ramal} | ${r.andar.padEnd(10)} | ${r.setor}`);

if (semRamal.length) {
  console.log('\n=== itens sem ramal de 4 digitos ===');
  for (const s of semRamal.slice(0, 10)) console.log(` "${s.ramal}" | ${s.andar} | ${s.setor}`);
}
