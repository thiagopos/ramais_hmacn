/**
 * Utilitário de pool de concorrência simples.
 */

export async function pMap(items, fn, concurrency = 32) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Formata segundos em mm:ss. */
export function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${String(s).padStart(2, '0')}s`;
}
