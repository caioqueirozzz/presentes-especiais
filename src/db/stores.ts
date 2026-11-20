import { config } from "../config.js";
import { MemoryProductIndexStore, type ProductIndexStore } from "../catalogo/indice.js";
import { PgProductIndexStore } from "../catalogo/indicePg.js";
import type { Banco } from "./banco.js";
import { PgLacunaStore } from "../knowledge/lacunas.js";
import { PgOrderIndexStore } from "../integrations/brindeme/orderIndex.js";
import { MotorSemantico } from "../catalogo/semantica.js";
import { gerarTiposEVetores } from "../catalogo/geracao.js";
import { PgTipoStore, PgVectorStore } from "../catalogo/vetoresPg.js";
import { MemoryTipoStore } from "../catalogo/tipos.js";
import { MemoryVectorStore } from "../catalogo/vetores.js";
import { clienteEmbeddingsPadrao } from "../llm/embeddings.js";
import { clienteRotuloPadrao } from "../llm/rotulador.js";
import { setMotorSemantico, setProductIndexStore } from "../tools/buscarProdutos.js";
import { setLacunaStore } from "../tools/consultarConhecimento.js";
import { setOrderIndexStore } from "../tools/consultarPedido.js";

/** Liga nas tools os stores do banco. Toda entrada que atende cliente chama isto depois de abrirBanco(). */
export function ligarStores(banco: Banco, modo: "mock" | "http" = config.brindeMe.mode): ProductIndexStore {
  setLacunaStore(new PgLacunaStore(banco));
  setOrderIndexStore(new PgOrderIndexStore(banco));
  // Em mock o catálogo vem dos fixtures, em memória: produto de teste nunca entra no catálogo real do banco.
  const catalogo = modo === "http" ? new PgProductIndexStore(banco) : new MemoryProductIndexStore();
  setProductIndexStore(catalogo);
  return catalogo;
}

/**
 * Liga a busca semântica. Sem OPENAI_API_KEY não há motor e a busca fica no BM25.
 * Em http os vetores vêm do banco; em mock são gerados na partida sobre os fixtures, só em memória.
 */
export async function ligarSemantica(banco: Banco | null, catalogo: ProductIndexStore, modo: "mock" | "http" = config.brindeMe.mode): Promise<void> {
  const chave = config.openaiApiKey;
  if (!chave) return setMotorSemantico(null);
  const embeddings = clienteEmbeddingsPadrao(chave);
  if (modo === "http") {
    if (!banco) throw new Error("ligarSemantica em http precisa do banco");
    return setMotorSemantico(
      new MotorSemantico({ vetoresProduto: new PgVectorStore(banco, "produto"), vetoresTipo: new PgVectorStore(banco, "tipo"), tipos: new PgTipoStore(banco), embeddings })
    );
  }
  const deps = { tipos: new MemoryTipoStore(), vetoresProduto: new MemoryVectorStore(), vetoresTipo: new MemoryVectorStore() };
  await gerarTiposEVetores((await catalogo.carregar()).produtos, { ...deps, embeddings, rotulos: clienteRotuloPadrao(chave) });
  setMotorSemantico(new MotorSemantico({ ...deps, embeddings }));
}
