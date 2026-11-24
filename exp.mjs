import net from "node:net";
import { execSync } from "node:child_process";

// Se o SIP estiver bloqueado/fechado, um telefone ALE ainda pode ser
// encontrado por: porta 443 (web) e pelo ARP se estiver na mesma L2.
console.log("=== alguma coisa viva nas faixas? (TCP 443 e 80) ===\n");
function tcp(ip, porta, timeout = 900) {
  return new Promise((r) => {
    const s = net.connect({ host: ip, port: porta, timeout });
    s.on("connect", () => { s.destroy(); r(true); });
    s.on("timeout", () => { s.destroy(); r(false); });
    s.on("error", () => r(false));
  });
}
const vivos = [];
for (const base of ["192.168.48", "192.168.54"]) {
  for (let i = 1; i < 255; i += 1) {
    const ip = `${base}.${i}`;
    const a = await tcp(ip, 443), b = await tcp(ip, 80);
    if (a || b) vivos.push({ ip, p443: a, p80: b });
  }
}
console.log(`  hosts com 443 ou 80 abertos: ${vivos.length}`);
for (const v of vivos.slice(0, 15)) console.log("   ", JSON.stringify(v));

console.log("\n=== rota para essas faixas existe? ===");
try {
  const out = execSync("route print -4", { encoding: "latin1", timeout: 15000 });
  for (const faixa of ["192.168.48", "192.168.54"]) {
    const linhas = out.split(/\r?\n/).filter(l => l.includes(faixa));
    console.log(`  ${faixa}.x: ${linhas.length ? linhas.map(l=>l.trim()).join(" | ") : "NENHUMA ROTA ESPECIFICA"}`);
  }
  const def = out.split(/\r?\n/).filter(l => /0\.0\.0\.0\s+0\.0\.0\.0/.test(l));
  console.log("  rota padrao:", def.map(l=>l.trim()).join(" | ") || "nenhuma");
} catch (e) { console.log("  erro ao ler rotas:", e.message); }
