/**
 * Sonda de ritmo da rota de preço da vitrine (spec 9.3): a brinde.me não diz o limite de chamadas.
 * Sobe o ritmo em degraus de 30 s (1, 2, 4, 8 e 16 chamadas por segundo), com 10 s de pausa entre eles,
 * e PARA no primeiro 429 ou erro: nenhuma chamada nova depois dele. No máximo 8 chamadas em andamento.
 *
 *   npm run sondar:ritmo-precos
 *   npm run sondar:ritmo-precos -- --subproduto <id>   # sem isto, usa uma cor da Camisa Dray Fit pela API oficial
 *
 * Roda ANTES da migração do índice (por isso não lê o índice). Rode fora do horário de pico, com o agente desligado,
 * e antes do conferir:precos. Leva no máximo ~3 min.
 */
import "dotenv/config";
import { HttpBrindeMeClient } from "../src/integrations/brindeme/httpClient.js";
import { DOMINIO_LOJA, ROTA_VITRINE } from "../src/integrations/brindeme/precoVenda.js";
import { sondarRitmo, type RespostaSonda } from "../src/operacao/conferenciaPrecos.js";

const DRAY_FIT = "afc89ae2-d187-405a-b826-d2e2ae0447f5";

async function chamar(subprodutoId: string): Promise<RespostaSonda> {
  const inicio = Date.now();
  try {
    const r = await fetch(`${ROTA_VITRINE}/api/subproduct/${encodeURIComponent(subprodutoId)}/price/10?domain=${DOMINIO_LOJA}`, {
      headers: { Accept: "application/json", domain: DOMINIO_LOJA },
      signal: AbortSignal.timeout(5_000),
    });
    await r.text();
    return { status: r.status, ms: Date.now() - inicio, retryAfter: r.headers.get("retry-after") };
  } catch {
    return { status: "erro", ms: Date.now() - inicio };
  }
}

async function main(): Promise<void> {
  const i = process.argv.indexOf("--subproduto");
  let sub = i === -1 ? undefined : process.argv[i + 1];
  if (!sub) {
    const dray = await new HttpBrindeMeClient().getProduct(DRAY_FIT);
    sub = dray.subproducts.find((s) => s.status)?.id;
  }
  if (!sub) {
    console.error("Não achei um subproduto da Camisa Dray Fit: passe --subproduto <id>.");
    process.exit(1);
  }
  const r = await sondarRitmo({
    chamar: () => chamar(sub),
    ritmos: [1, 2, 4, 8, 16],
    degrauMs: 30_000,
    pausaMs: 10_000,
    maxEmAndamento: 8,
    agora: Date.now,
    dormir: (ms) => new Promise((ok) => setTimeout(ok, ms)),
    log: console.log,
  });
  console.log(`Último ritmo sem erro: ${r.ultimoBom}/s em ${r.chamadas} chamada(s). Leve este número ao relatório: ele define a concorrência do sync:precos.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
