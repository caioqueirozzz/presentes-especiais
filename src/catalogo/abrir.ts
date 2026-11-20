import { config } from "../config.js";
import { abrirBanco } from "../db/banco.js";
import { createBrindeMeClient } from "../integrations/brindeme/factory.js";
import { MemoryProductIndexStore, sincronizarCatalogo, type IndiceCatalogo } from "./indice.js";
import { PgProductIndexStore } from "./indicePg.js";
import { PgTipoStore, PgVectorStore } from "./vetoresPg.js";
import type { TipoStore } from "./tipos.js";
import type { VectorStore } from "./vetores.js";

/** Para os scripts que só leem o catálogo: o do banco (http) ou o dos fixtures (mock, em memória, nunca gravado). */
export async function carregarIndiceDeScript(): Promise<IndiceCatalogo> {
  if (config.brindeMe.mode !== "http") {
    const store = new MemoryProductIndexStore();
    await sincronizarCatalogo(createBrindeMeClient(), store);
    return store.carregar();
  }
  const banco = await abrirBanco();
  try {
    return await new PgProductIndexStore(banco).carregar();
  } finally {
    await banco.fechar();
  }
}

/** Para os scripts que gravam o catálogo: só existe com a API real, porque o mock nunca vai ao banco. */
export async function abrirCatalogoHttp(script: string): Promise<{ store: PgProductIndexStore; fechar: () => Promise<void> }> {
  if (config.brindeMe.mode !== "http") {
    console.error(`${script} só roda com BRINDEME_MODE=http: o catálogo do mock fica em memória e nunca é gravado no banco.`);
    process.exit(1);
  }
  const banco = await abrirBanco();
  return { store: new PgProductIndexStore(banco), fechar: () => banco.fechar() };
}

/** Tipos e vetores do banco, para gerar:vetores e comparar:busca. `null` no mock: lá os vetores só existem em memória na partida. */
export async function abrirSemanticaHttp(
  script: string
): Promise<{ tipos: TipoStore; vetoresProduto: VectorStore; vetoresTipo: VectorStore; fechar: () => Promise<void> } | null> {
  if (config.brindeMe.mode !== "http") {
    console.error(`${script} só roda com BRINDEME_MODE=http: no mock os vetores são gerados em memória a cada partida, nada fica gravado.`);
    return null;
  }
  const banco = await abrirBanco();
  return {
    tipos: new PgTipoStore(banco),
    vetoresProduto: new PgVectorStore(banco, "produto"),
    vetoresTipo: new PgVectorStore(banco, "tipo"),
    fechar: () => banco.fechar(),
  };
}
