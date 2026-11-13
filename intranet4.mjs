import fs from 'node:fs';
const html = fs.readFileSync('intranet-ramais.html', 'utf8');

// lista <ul id="myUL"> ... </ul> por andar
const uls = [...html.matchAll(/<ul[^>]*id="(myUL\d*)"[^>]*>([\s\S]*?)<\/ul>/gi)];
console.log('listas encontradas:', uls.map((u) => u[1]).join(', '));

for (const [, id, conteudo] of uls.slice(0, 1)) {
  console.log(`\n=== amostra da ${id} ===`);
  const lis = [...conteudo.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)];
  console.log('itens:', lis.length);
  for (const l of lis.slice(0, 6)) {
    const dd = (l[1].match(/<dd[^>]*>([\s\S]*?)<\/dd>/i) || [])[1] || '';
    const p = (l[1].match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
    const limpa = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`  dd="${limpa(dd)}"  p="${limpa(p)}"`);
  }
}

// tambem procura cabecalhos de andar
const andares = [...html.matchAll(/<button[^>]*class="tablinks"[^>]*onclick="openCity\(event,\s*'([^']+)'\)"[^>]*>([\s\S]*?)<\/button>/gi)];
console.log('\n=== botoes de andar ===');
for (const m of andares) console.log(` ${m[1]}: ${m[2].replace(/\s+/g, ' ').trim()}`);
