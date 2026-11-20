import { describe, it, expect, afterEach } from "vitest";
import { buscarProdutosHandler, setProductIndexStore } from "../src/tools/buscarProdutos.js";
import { indiceVazio, type IndiceCatalogo, type ProductIndexStore } from "../src/catalogo/indice.js";
import { createInitialState } from "../src/agent/state.js";
import { ClienteCatalogoFalso } from "./helpers/produtos.js";

describe("getIndice", () => {
  afterEach(() => setProductIndexStore(null));

  it("sem índice carregado, lê uma vez e guarda: a pergunta seguinte não vai ao store", async () => {
    let leituras = 0;
    const store: ProductIndexStore = {
      carregar: async (): Promise<IndiceCatalogo> => (leituras++, indiceVazio()),
      salvar: async () => {},
    };
    setProductIndexStore(store);
    const client = new ClienteCatalogoFalso([]);
    await buscarProdutosHandler({ consulta: "caneca" }, createInitialState("5583999990000"), client);
    await buscarProdutosHandler({ consulta: "caneca" }, createInitialState("5583999990000"), client);
    expect(leituras).toBe(1);
  });
});
