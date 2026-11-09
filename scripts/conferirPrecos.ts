/**
 * Critério de aceite da Fase 0 (spec 9.3): o preço que as ferramentas dão é o da vitrine, com tolerância zero.
 * Também confere, na mesma amostra, que nenhum preço guardado no índice é igual ao custo da API ao vivo.
 *
 *   npm run conferir:precos                       # 100 produtos, semente 20261105
 *   npm run conferir:precos -- --produtos 20 --semente 7 --pausa-ms 500
 *
 * Precisa de BRINDEME_MODE=http e do índice v2. Faz ~2 mil chamadas (~20 por produto, entre a vitrine e a API oficial):
 * rode com o agente desligado e DEPOIS da sonda de ritmo (sondar:ritmo-precos). --pausa-ms (padrão 500) espaça os produtos.
 * Sai 1 se nada foi conferido, se mais de 10% das conferências foram puladas, ou em qualquer divergência/falha da rota.
 * Não grava nada: preparar_orcamento só estima (R5).
 */
import "dotenv/config";
import { config } from "../src/config.js";
import { FileProductIndexStore } from "../src/catalogo/indice.js";
import { MAX_CORES_COTADAS } from "../src/catalogo/cotacao.js";
import { createBrindeMeClient } from "../src/integrations/brindeme/factory.js";
import { HttpBrindeMeClient } from "../src/integrations/brindeme/httpClient.js";
import { PrecoVendaHttp } from "../src/integrations/brindeme/precoVenda.js";
import { detalharProdutoHandler } from "../src/tools/detalharProduto.js";
import { prepararOrcamentoHandler } from "../src/tools/prepararOrcamento.js";
import { createInitialState } from "../src/agent/state.js";
import { decidirSaida, quantidadesDeTeste, sortear, sorteador } from "../src/operacao/conferenciaPrecos.js";

const SEMPRE = new Set(["afc89ae2-d187-405a-b826-d2e2ae0447f5", "dd4c5dbf-ab7d-4084-8c2b-e2f7e28669de"]);
const TELEFONE_FICTICIO = "5500000000000";

type Detalhe = {
  erro?: { erro?: string };
  resultado?: string;
  subprodutos_ativos?: Array<{ subproduto_id: string; cor: string; preco_para_quantidade: number | null; atende_quantidade: boolean | null }>;
};

function numero(nome: string, padrao: number): number {
  const i = process.argv.indexOf(`--${nome}`);
  const n = i === -1 ? NaN : Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

async function main(): Promise<void> {
  if (config.brindeMe.mode !== "http") {
    console.error("conferir:precos precisa de BRINDEME_MODE=http.");
    process.exit(1);
  }
  const aleatorio = sorteador(numero("semente", 20261105));
  const indice = new FileProductIndexStore().carregar();
  if (indice.produtos.length === 0) {
    console.error("Índice vazio ou v1: rode npm run sync:precos -- --migrar.");
    process.exit(1);
  }
  // Dois clientes na mesma API oficial: dividem o ritmo, senão somam o dobro e vem 429 (limite_excedido).
  const ritmo = Math.max(1, Math.floor(config.catalogo.reqPorMinuto / 2));
  const client = createBrindeMeClient({ reqPorMinuto: ritmo });
  const custoCru = new HttpBrindeMeClient({ reqPorMinuto: ritmo });
  const vitrine = new PrecoVendaHttp();
  const pausa = numero("pausa-ms", 500);

  const amostra = sortear(indice.produtos, numero("produtos", 100), aleatorio, (p) => SEMPRE.has(p.id));
  let conferidos = 0;
  let falhasDaRota = 0;
  const puladas: string[] = [];
  const divergencias: string[] = [];
  const iguaisAoCusto: string[] = [];

  for (const [n, p] of amostra.entries()) {
    if (n > 0) await new Promise((r) => setTimeout(r, pausa));
    if (n % 10 === 0) console.log(`  ${n}/${amostra.length} produtos (${conferidos} conferido(s), ${puladas.length} pulada(s))`);
    const base = p.subprodutos[Math.floor(aleatorio() * p.subprodutos.length)];
    if (!base) continue;
    const minimo = Math.max(1, p.quantidade_minima);
    const teto = Math.max(0, ...p.subprodutos.map((s) => s.estoque));
    // Sem estoque para o mínimo: o agente não cota nenhuma cor, não há preço a conferir.
    const quantidades = teto < minimo ? [] : quantidadesDeTeste(base.limites ?? [], minimo, aleatorio, 3, teto);
    for (const [i, q] of quantidades.entries()) {
      const det = (await detalharProdutoHandler({ produto_id: p.id, quantidade: q }, createInitialState(TELEFONE_FICTICIO), client)) as Detalhe;
      if (!det.subprodutos_ativos) {
        puladas.push(`detalhar ${p.nome} ${q} un.: devolveu erro (${det.erro?.erro ?? det.resultado ?? "sem detalhe"})`);
        continue;
      }
      // O detalhar só cota as primeiras cores que atendem: fora delas o preço é null e não é divergência.
      const cotadas = det.subprodutos_ativos.filter((s) => s.atende_quantidade).slice(0, MAX_CORES_COTADAS);
      const cor = cotadas[Math.floor(aleatorio() * cotadas.length)];
      if (!cor) {
        puladas.push(`detalhar ${p.nome} ${q} un.: nenhuma cor cotável`);
        continue;
      }
      let site: number;
      try {
        site = (await vitrine.consultar(cor.subproduto_id, [q])).get(q) ?? 0;
      } catch (err) {
        falhasDaRota++;
        console.log(`  falha da rota: ${p.nome} (${cor.cor}) ${q} un.: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      conferidos++;
      const agente = cor.preco_para_quantidade === null ? 0 : Math.round(cor.preco_para_quantidade * 100);
      if (agente !== site) divergencias.push(`detalhar ${p.nome} (${cor.cor}) ${q} un.: agente ${agente} × site ${site}`);
      if (i === 0) {
        const state = createInitialState(TELEFONE_FICTICIO);
        state.subprodutoParaProduto[cor.subproduto_id] = p.id;
        const orc = (await prepararOrcamentoHandler(
          { tipo: "PF", nome: "Conferência de preços", email: "conferencia@example.com", itens: [{ subproduto_id: cor.subproduto_id, quantidade: q }] },
          state,
          client
        )) as { resumo?: { itens: Array<{ preco_unitario: number }> }; erro?: string };
        if (orc.resumo || orc.erro === "preco_indisponivel") {
          conferidos++;
          const doOrcamento = orc.resumo ? Math.round(orc.resumo.itens[0].preco_unitario * 100) : 0;
          if (doOrcamento !== site) divergencias.push(`orcamento ${p.nome} (${cor.cor}) ${q} un.: agente ${doOrcamento} × site ${site}`);
        } else {
          puladas.push(`orcamento ${p.nome} (${cor.cor}) ${q} un.: ${orc.erro ?? "sem resumo"}`);
        }
      }
    }
    const cru = await custoCru.getProduct(p.id).catch(() => null);
    const subCru = cru?.subproducts.find((s) => s.id === base.id);
    if (!subCru) puladas.push(`custo ${p.nome} (${base.cor}): não foi possível ler`);
    for (const f of base.faixas) {
      const c = subCru?.prices.find((x) => f.min >= x.min && f.min <= x.max);
      // Só nome, cor e faixa: o valor do custo nunca é mostrado.
      if (c && Math.round(c.price * 100) === Math.round(f.preco * 100)) iguaisAoCusto.push(`${p.nome} (${base.cor}) faixa a partir de ${f.min} un.`);
    }
  }

  console.log(`\n${conferidos} preço(s) conferido(s) em ${amostra.length} produto(s); ${amostra.filter((p) => SEMPRE.has(p.id)).length} de ${SEMPRE.size} produtos obrigatórios na amostra.`);
  console.log(`Puladas: ${puladas.length}`);
  for (const d of puladas) console.log(`  ${d}`);
  console.log(`Falhas da rota: ${falhasDaRota}`);
  console.log(`Divergências do site: ${divergencias.length}`);
  for (const d of divergencias) console.log(`  ${d}`);
  console.log(`Preços do índice iguais ao custo: ${iguaisAoCusto.length}`);
  for (const d of iguaisAoCusto) console.log(`  ${d}`);
  const saida = decidirSaida({ conferidos, puladas: puladas.length, divergencias: divergencias.length, iguaisAoCusto: iguaisAoCusto.length, falhasDaRota });
  if (saida.codigo) {
    console.log(`BLOQUEIO: ${saida.motivos.join("; ")}.`);
    process.exit(1);
  }
  console.log("100% igual ao site e nenhum custo no índice.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
