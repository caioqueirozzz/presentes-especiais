/**
 * Etapa 3 da busca semântica (spec §4.3 e §4.4): os dois achados do dogfooding
 * que não são da busca em si, mas do que a conversa faz com o resultado dela.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  buscarProdutosHandler,
  setProductIndexStore,
  setOccasionTagStore,
  setMotorSemantico,
} from "../src/tools/buscarProdutos.js";
import { detalharProdutoHandler } from "../src/tools/detalharProduto.js";
import { MemoryProductIndexStore, sincronizarCatalogo } from "../src/catalogo/indice.js";
import { MemoryOccasionTagStore } from "../src/catalogo/ocasioes.js";
import { createInitialState, type ConversationState } from "../src/agent/state.js";
import { ClienteCatalogoFalso, produto, sub } from "./helpers/produtos.js";
import { montarCartao } from "../src/tools/cartao.js";
import type { Cotacao } from "../src/catalogo/cotacao.js";

/** Miniatura de empilhadeira do dogfooding: mínimo 20, estoque 50, pedido de 200. */
function catalogo() {
  return [
    produto({
      id: "empilhadeira",
      nome: "Miniatura Empilhadeira Metal",
      categoria: "Colecionáveis",
      min: 20,
      subprodutos: [sub("emp-amarela", "Amarela", 50, [[20, 999, 31.27]])],
    }),
  ];
}

let state: ConversationState;
let client: ClienteCatalogoFalso;

beforeEach(async () => {
  client = new ClienteCatalogoFalso(catalogo());
  const index = new MemoryProductIndexStore();
  await sincronizarCatalogo(client, index, { agora: new Date("2026-11-09T10:00:00Z") });
  setProductIndexStore(index);
  setOccasionTagStore(new MemoryOccasionTagStore({ porProduto: {}, porSku: {}, porCategoria: {} }));
  setMotorSemantico(null); // sem rede: esta etapa não depende da semântica
  state = createInitialState("5583999990000");
});

describe('§4.3 "quero N dessa" sobre um produto que só apareceu como ajuste', () => {
  it("o produto do ajuste entra em ultimasOpcoes e em produtosDiscutidos", async () => {
    const r = (await buscarProdutosHandler({ consulta: "miniatura empilhadeira", quantidade: 200 }, state, client)) as {
      resultado: string;
      ajustes_sugeridos: Array<{ produto_id: string; quantidade: number }>;
    };

    expect(r.resultado).toBe("nenhum_produto_encontrado");
    expect(r.ajustes_sugeridos[0].produto_id).toBe("empilhadeira");

    // Era isto que faltava: sem o id no estado, o modelo buscava de novo e trazia
    // outro produto (os 3 Carro Miniatura do dogfooding).
    expect(state.ultimasOpcoes?.map((o) => o.id)).toEqual(["empilhadeira"]);
    expect(state.produtosDiscutidos).toContain("empilhadeira");
  });

  it("a cor cotada do ajuste vai junto, para o orçamento não precisar adivinhar", async () => {
    await buscarProdutosHandler({ consulta: "miniatura empilhadeira", quantidade: 200 }, state, client);
    expect(state.ultimasOpcoes?.[0].cores).toEqual([{ subproduto_id: "emp-amarela", cor: "Amarela" }]);
    expect(state.subprodutoParaProduto["emp-amarela"]).toBe("empilhadeira");
  });

  it('o id do ajuste funciona em detalhar_produto: "quero 50 dessa" não vira busca nova', async () => {
    const busca = (await buscarProdutosHandler({ consulta: "miniatura empilhadeira", quantidade: 200 }, state, client)) as {
      ajustes_sugeridos: Array<{ produto_id: string }>;
    };
    const id = busca.ajustes_sugeridos[0].produto_id;

    const detalhe = (await detalharProdutoHandler({ produto_id: id, quantidade: 50 }, state, client)) as {
      id?: string;
      nome?: string;
      instrucao_ao_agente?: string;
    };

    expect(detalhe.id).toBe("empilhadeira");
    expect(detalhe.instrucao_ao_agente ?? "").not.toMatch(/não existe/);
  });
});

describe("§4.4 cliente não disse a quantidade", () => {
  it("cota no pedido mínimo do produto e avisa que o preço é dele", async () => {
    const r = (await buscarProdutosHandler({ consulta: "miniatura empilhadeira" }, state, client)) as {
      resultado: string;
      aviso: string;
      produtos: Array<Record<string, unknown>>;
      cartoes: Array<{ legenda: string }>;
    };

    expect(r.resultado).toBe("produtos_encontrados");
    // 20 é o mínimo do produto, não um número que o cliente deu
    expect(client.consultasDePreco.flatMap((c) => c.quantidades)).toContain(20);
    expect(r.produtos[0].min_quantity).toBe(20);
    expect(r.produtos[0].preco_unitario_no_pedido_minimo).toBe(31.27);
    expect(r.produtos[0]).not.toHaveProperty("total_estimado");
    expect(r.cartoes[0].legenda).toContain("no pedido mínimo de 20 un.");
    expect(r.aviso).toMatch(/pergunte quantas unidades/i);
  });

  it("com a quantidade, o cartão volta a falar do pedido do cliente", async () => {
    const r = (await buscarProdutosHandler({ consulta: "miniatura empilhadeira", quantidade: 30 }, state, client)) as {
      cartoes: Array<{ legenda: string }>;
      produtos: Array<Record<string, unknown>>;
    };
    expect(r.cartoes[0].legenda).toContain("para 30 un.");
    expect(r.cartoes[0].legenda).not.toContain("pedido mínimo");
    expect(r.produtos[0]).toHaveProperty("total_estimado");
  });
});

describe("montarCartao — a frase do preço", () => {
  const cotacao: Cotacao = {
    subproduto_id: "s1",
    quantidade: 50,
    centavos: 1990,
    fonte: "site",
    em: "2026-11-16T12:00:00.000Z",
  };

  it("no_minimo troca 'para N un.' por 'no pedido mínimo de N un.'", () => {
    const base = { produto_id: "p", nome: "Caneca", imagem_url: null, outras: [] };
    const cotadas = [{ cor: "Azul", cotacao }];
    expect(montarCartao({ ...base, quantidade: 50, cotadas }).legenda).toMatch(/R\$\s19,90\/un para 50 un\./);
    expect(montarCartao({ ...base, quantidade: 50, no_minimo: true, cotadas }).legenda).toMatch(
      /R\$\s19,90\/un no pedido mínimo de 50 un\./
    );
  });

  it("com cores de preços diferentes, o cabeçalho também diz que é o mínimo", () => {
    const cotadas = [
      { cor: "Azul", cotacao },
      { cor: "Roxa", cotacao: { ...cotacao, subproduto_id: "s2", centavos: 2190 } },
    ];
    const legenda = montarCartao({
      produto_id: "p",
      nome: "Caneca",
      imagem_url: null,
      quantidade: 50,
      no_minimo: true,
      cotadas,
      outras: [],
    }).legenda;
    expect(legenda).toContain("No pedido mínimo de 50 un.:");
  });
});
