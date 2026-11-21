import { MockBrindeMeClient } from "../src/integrations/brindeme/mockClient.js";
import { MemoryProductIndexStore, sincronizarCatalogo } from "../src/catalogo/indice.js";
import { MemoryOrderIndexStore, sincronizarPedidos } from "../src/integrations/brindeme/orderIndex.js";
import { setProductIndexStore } from "../src/tools/buscarProdutos.js";
import { setOrderIndexStore } from "../src/tools/consultarPedido.js";
import { setLacunaStore } from "../src/tools/consultarConhecimento.js";
import { MemoryLacunaStore } from "../src/knowledge/lacunas.js";
import { ligarSemantica } from "../src/db/stores.js";
import { setEncaminharParaDesign } from "../src/integrations/crm/design.js";

/** Os cenários rodam só sobre os mocks: nada lido de data/ nem gravado na fila real de lacunas. */
/** `semantica` gera os vetores dos fixtures na OpenAI (centavos); os testes de unidade não pedem. */
export async function prepararAmbienteDosEvals(opcoes: { semantica?: boolean } = {}): Promise<void> {
  const produtos = new MemoryProductIndexStore();
  await sincronizarCatalogo(new MockBrindeMeClient(), produtos);
  setProductIndexStore(produtos);
  if (opcoes.semantica) await ligarSemantica(null, produtos, "mock");

  const pedidos = new MemoryOrderIndexStore();
  await sincronizarPedidos(new MockBrindeMeClient(), pedidos);
  setOrderIndexStore(pedidos);

  setLacunaStore(new MemoryLacunaStore());
  // Nenhum eval abre job no CRM de verdade
  setEncaminharParaDesign(async (p) => ({ jobId: "job-eval", imagens: p.arquivos.length }));
}
