import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { recomendar } from "../src/catalogo/recomendar.js";
import { construirRegistro, MemoryProductIndexStore, VERSAO_INDICE } from "../src/catalogo/indice.js";
import { MemoryOccasionTagStore } from "../src/catalogo/ocasioes.js";
import { setLogPrecos, type PrecoDivergente } from "../src/catalogo/logPrecos.js";
import { buscarProdutosHandler, setProductIndexStore, setOccasionTagStore } from "../src/tools/buscarProdutos.js";
import { SEM_PRECO } from "../src/tools/cartao.js";
import { ErroPrecoVenda } from "../src/integrations/brindeme/precoVenda.js";
import { createInitialState } from "../src/agent/state.js";
import { ClienteCatalogoFalso, produto, sub } from "./helpers/produtos.js";
import type { Product } from "../src/integrations/brindeme/types.js";

const T0 = new Date("2026-11-06T12:00:00Z");

function montar(produtos: Product[]) {
  const index = new MemoryProductIndexStore({
    versao: VERSAO_INDICE,
    sincronizado_em: T0.toISOString(),
    completo: true,
    produtos: produtos.map((p) => construirRegistro(p, T0)),
  });
  const client = new ClienteCatalogoFalso(produtos);
  setProductIndexStore(index);
  setOccasionTagStore(new MemoryOccasionTagStore());
  return { index, client, deps: { index, tags: new MemoryOccasionTagStore(), client, agora: () => T0 } };
}

const azul = () => produto({ id: "azul", nome: "Caneca Azul", subprodutos: [sub("a1", "Azul", 1000, [[1, 9999, 10]])] });
const verde = () => produto({ id: "verde", nome: "Caneca Verde", subprodutos: [sub("v1", "Verde", 1000, [[1, 9999, 12]])] });

describe("busca com o preço exato do site", () => {
  // Toda cotação diferente do índice loga: sem isto o teste escreveria em logs/precos.jsonl.
  beforeEach(() => setLogPrecos(() => {}));
  afterEach(() => {
    setProductIndexStore(null);
    setOccasionTagStore(null);
    setLogPrecos(null);
  });

  it("o preço da saída é o da cotação, não o da tabela; cada produto vira um cartão; sem SKU", async () => {
    const { client } = montar([azul()]);
    client.precoVendaFixo.set("a1", 1111);
    const state = createInitialState("5583999990000");
    const r = (await buscarProdutosHandler({ consulta: "caneca", quantidade: 50 }, state, client)) as {
      produtos: Array<Record<string, unknown>>;
      cartoes: Array<{ produto_id: string; legenda: string; imagem_url: string | null }>;
    };
    expect(r.produtos[0]).toMatchObject({ preco_unitario_na_quantidade: 11.11, total_estimado: 555.5 });
    expect(r.produtos[0].sku).toBeUndefined();
    expect(r.cartoes).toHaveLength(1);
    expect(r.cartoes[0]).toMatchObject({ produto_id: "azul", imagem_url: "https://cdn.teste/azul.jpg" });
    expect(r.cartoes[0].legenda).toContain("*Caneca Azul*");
    expect(state.cotacoes?.["a1:50"]).toMatchObject({ centavos: 1111, fonte: "site" });
  });

  it("orçamento conferido de novo com o preço exato: o item que estoura sai e entra o próximo", async () => {
    const { client, deps } = montar([azul(), verde()]);
    client.precoVendaFixo.set("a1", 1500);
    const r = await recomendar({ consulta: "caneca", quantidade: 50, precoMaxUnitario: 13 }, deps);
    expect(r.tipo).toBe("encontrados");
    if (r.tipo !== "encontrados") return;
    expect(r.itens.map((i) => i.produto.id)).toEqual(["verde"]);
    expect(r.descartadosNaRevalidacao).toBeGreaterThanOrEqual(1);
  });

  it("Foco da revisão 4: cotação que falha com orçamento informado mantém o produto, sem preço", async () => {
    const { client } = montar([azul()]);
    client.falhaNoPreco.set("a1", new ErroPrecoVenda("rede", "fora"));
    const r = (await buscarProdutosHandler({ consulta: "caneca", quantidade: 50, preco_max_unitario: 20 }, createInitialState("5583999990000"), client)) as {
      produtos: Array<{ id: string; preco_unitario_na_quantidade: number | null }>;
      cartoes: Array<{ legenda: string }>;
    };
    expect(r.produtos.map((p) => p.id)).toEqual(["azul"]);
    expect(r.produtos[0].preco_unitario_na_quantidade).toBeNull();
    expect(r.cartoes[0].legenda).toContain(SEM_PRECO);
  });

  it("cotação diferente do índice: vale a cotação, o log registra preco_divergente e o grupo é corrigido em memória", async () => {
    const vistos: PrecoDivergente[] = [];
    setLogPrecos((e) => vistos.push(e));
    const { client, index } = montar([azul()]);
    client.precoVendaFixo.set("a1", 1100);
    await buscarProdutosHandler({ consulta: "caneca", quantidade: 50 }, createInitialState("5583999990000"), client);
    expect(vistos).toEqual([{ produto_id: "azul", grupo_preco: "", subproduto_id: "a1", quantidade: 50, indice: 1000, site: 1100 }]);
    expect(index.carregar().produtos[0].subprodutos[0].faixas).toEqual([{ min: 1, max: 9999, preco: 11 }]);
  });

  it("sem quantidade: nenhuma cotação, cartão só com nome e cores", async () => {
    const { client } = montar([azul()]);
    const r = (await buscarProdutosHandler({ consulta: "caneca" }, createInitialState("5583999990000"), client)) as { cartoes: Array<{ legenda: string }> };
    expect(client.consultasDePreco).toEqual([]);
    expect(r.cartoes[0].legenda).toBe("*Caneca Azul*\nCores: Azul");
  });

  it("todos os resultados sem estoque: diz que não tem no estoque e oferece o humano", async () => {
    const { client } = montar([produto({ id: "cam", nome: "Camiseta", subprodutos: [sub("c1", "Branca", 0, [[1, 9999, 35]])] })]);
    const r = (await buscarProdutosHandler({ consulta: "camiseta", quantidade: 30 }, createInitialState("5583999990000"), client)) as { instrucao_ao_agente: string };
    expect(r.instrucao_ao_agente).toMatch(/não tem no estoque/);
    expect(r.instrucao_ao_agente).toMatch(/humano/);
  });

  it("cores com preço diferente: o total que vai ao modelo diz de qual cor é (a mais barata)", async () => {
    const { client } = montar([produto({ id: "c", nome: "Caneca", min: 10, subprodutos: [sub("c1", "Azul", 1000, [[10, 9999, 10]]), sub("c2", "Roxa", 1000, [[10, 9999, 11]])] })]);
    client.precoVendaFixo.set("c1", 1100);
    client.precoVendaFixo.set("c2", 1000);
    const r = (await buscarProdutosHandler({ consulta: "caneca", quantidade: 10 }, createInitialState("5583999990000"), client)) as any;
    expect(r.produtos[0]).toMatchObject({ total_estimado: 100, cor_do_total: "Roxa" });
  });

  it("cores com o mesmo preço: sem cor_do_total", async () => {
    const { client } = montar([produto({ id: "c", nome: "Caneca", min: 10, subprodutos: [sub("c1", "Azul", 1000, [[10, 9999, 10]]), sub("c2", "Roxa", 1000, [[10, 9999, 10]])] })]);
    const r = (await buscarProdutosHandler({ consulta: "caneca", quantidade: 10 }, createInitialState("5583999990000"), client)) as any;
    expect(r.produtos[0].cor_do_total).toBeUndefined();
  });

  it("ajuste sugerido traz o preço exato do site", async () => {
    const { client, deps } = montar([produto({ id: "cad", nome: "Caderno", min: 50, subprodutos: [sub("d1", "Azul", 1000, [[50, 9999, 20]])] })]);
    client.precoVendaFixo.set("d1", 2100);
    const r = await recomendar({ consulta: "caderno", quantidade: 10 }, deps);
    expect(r.tipo).toBe("nenhum");
    if (r.tipo !== "nenhum") return;
    expect(r.ajustes).toEqual([{ tipo: "aumentar_quantidade", produto_id: "cad", nome: "Caderno", quantidade: 50, preco_unitario: 21, total_estimado: 1050, cor: "Azul" }]);
  });
});
