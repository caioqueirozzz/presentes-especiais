import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectarIntencao } from "../src/agent/intencao.js";
import { runTurn } from "../src/agent/runTurn.js";
import { createInitialState } from "../src/agent/state.js";
import { config } from "../src/config.js";
import { clienteDaLoja, setBuscarHistoricoCliente, type PedidoDoCliente } from "../src/integrations/crm/historicoCliente.js";
import { MockBrindeMeClient } from "../src/integrations/brindeme/mockClient.js";
import type { LLMProvider, LLMResponse } from "../src/llm/types.js";
import { Logger } from "../src/logging/logger.js";
import { iniciarNovoPedidoHandler } from "../src/tools/iniciarNovoPedido.js";
import { MENSAGEM_CANCELAMENTO } from "../src/tools/transferirHumano.js";
import { ScriptedLLM, endTurn } from "./helpers/llmRoteirizado.js";

describe("detectarIntencao", () => {
  it.each([
    "quero cancelar meu pedido",
    "Cancela tudo por favor",
    "preciso do ESTÔRNO",
    "vocês fazem reembolso?",
    "quero meu dinheiro de volta",
    "desisti do pedido",
    "não quero mais o pedido",
    "veio quebrado, quero o estorno",
  ])("cancelamento/estorno: %s", (texto) => {
    expect(detectarIntencao(texto)?.tipo).toBe("cancelamento");
  });

  it.each([
    "as canecas vieram quebradas",
    "o produto chegou errado",
    "a cor veio errada",
    "meu pedido ainda não chegou",
    "o pedido está atrasado",
    "atendimento péssimo",
    "quero trocar as camisetas",
    "tive um problema com o pedido",
    "veio faltando unidade",
    "vou abrir reclamação no Procon",
  ])("reclamação: %s", (texto) => {
    expect(detectarIntencao(texto)?.tipo).toBe("reclamacao");
  });

  it.each([
    "oi, tudo bem?",
    "quero 200 canecas para o natal",
    "sem problema, pode ser azul",
    "quanto custa o chaveiro?",
    "obrigado, chegou tudo certinho!",
    "me manda o catálogo",
  ])("conversa comum não dispara: %s", (texto) => {
    expect(detectarIntencao(texto)).toBeNull();
  });

  it("a cópia do CRM é idêntica (os dois projetos usam as mesmas palavras-chave)", () => {
    const raiz = join(import.meta.dirname, "..");
    expect(readFileSync(join(raiz, "crm/src/lib/intencao.ts"), "utf8")).toBe(readFileSync(join(raiz, "src/agent/intencao.ts"), "utf8"));
  });
});

describe("cancelamento e estorno nunca passam pela Lia", () => {
  it("transfere sem chamar o modelo, com prioridade alta e motivo cancelamento_estorno", async () => {
    const state = createInitialState("5583999990000");
    const llm = new ScriptedLLM([endTurn("não deveria responder")]);
    const transferencias: string[] = [];

    const r = await runTurn("quero cancelar o pedido PED-0003", state, llm, new MockBrindeMeClient(), new Logger("t-cancel"), {
      aoTransferir: (resumo) => transferencias.push(`${resumo.motivo}/${resumo.prioridade}`),
    });

    expect(llm.seen).toHaveLength(0);
    expect(r.response).toBe(MENSAGEM_CANCELAMENTO);
    expect(r.transferred).toBe(true);
    expect(transferencias).toEqual(["cancelamento_estorno/alta"]);
    expect(state.modo).toBe("humano");
    expect(state.ultimaTransferencia).toMatchObject({ motivo: "cancelamento_estorno", prioridade: "alta" });
  });

  it("com a conversa já com uma pessoa, nada sai", async () => {
    const state = createInitialState("5583999990000");
    state.modo = "humano";
    const r = await runTurn("quero estorno", state, new ScriptedLLM(), new MockBrindeMeClient(), new Logger("t-cancel"));
    expect(r.response).toBeNull();
  });
});

describe("iniciar_novo_pedido", () => {
  const cliente = {} as MockBrindeMeClient;

  it("guarda o pedido anterior, limpa o que é do pedido e mantém quem é o cliente", async () => {
    const state = createInitialState("5583999990000");
    state.cliente = { nome: "Ana", tipo: "PJ", email: "ana@x.com" };
    state.necessidade = { ocasiao: "natal", quantidade: 200 };
    state.produtosDiscutidos = ["Caneca"];
    state.orcamentoEnviado = {
      tipo: "PJ",
      nome: "Ana",
      email: "ana@x.com",
      telefone: "5583999990000",
      itens: [{ subproduto_id: "1", cor: "azul", nome_produto: "Caneca", quantidade: 200, preco_unitario: 10, subtotal: 2000 }],
      total_estimado: 2000,
      arte_refs: [],
      enviado_em: "2026-10-01T00:00:00.000Z",
    };

    const r = await iniciarNovoPedidoHandler({ o_que_procura: "chaveiros" }, state, cliente);

    expect(r.status).toBe("novo_pedido_iniciado");
    expect(state.ciclo).toBe(1);
    expect(state.necessidade).toEqual({});
    expect(state.produtosDiscutidos).toEqual([]);
    expect(state.orcamentoEnviado).toBeUndefined();
    expect(state.cliente).toEqual({ nome: "Ana", tipo: "PJ", email: "ana@x.com" });
    expect(state.pedidosAnteriores).toEqual([
      expect.objectContaining({ ocasiao: "natal", quantidade: 200, produtos: ["Caneca"], total_estimado: 2000 }),
    ]);
  });

  it("chamada repetida sem nada apurado não abre outro ciclo", async () => {
    const state = createInitialState("5583999990000");
    await iniciarNovoPedidoHandler({}, state, cliente);
    const r = await iniciarNovoPedidoHandler({}, state, cliente);
    expect(r.status).toBe("ja_em_novo_pedido");
    expect(state.ciclo).toBe(1);
  });
});

describe("cliente_da_loja no prompt", () => {
  const pedidos: PedidoDoCliente[] = [
    { codigo: "PED-0001", descricao: "200 canecas", etapa_atual: "Entregue", entregue: true, criado_em: "2026-09-01T12:00:00.000Z" },
    { codigo: "PED-0004", descricao: "50 cadernos", etapa_atual: "Em produção", entregue: false, criado_em: "2026-10-20T12:00:00.000Z" },
  ];

  it("separa os pedidos em andamento dos entregues", () => {
    expect(clienteDaLoja(pedidos, undefined)).toEqual({
      ja_cliente: true,
      pedidos_em_andamento: [{ codigo: "PED-0004", descricao: "50 cadernos", etapa_atual: "Em produção" }],
      pedidos_entregues: [{ codigo: "PED-0001", descricao: "200 canecas" }],
      novo_pedido_em_qualificacao: false,
    });
  });

  it("pedido novo aberto depois do último pedido do quadro está em qualificação; antes dele, não", () => {
    expect(clienteDaLoja(pedidos, "2026-11-01T00:00:00.000Z").novo_pedido_em_qualificacao).toBe(true);
    expect(clienteDaLoja(pedidos, "2026-10-01T00:00:00.000Z").novo_pedido_em_qualificacao).toBe(false);
  });

  it("CRM fora do ar: indisponível, não 'nunca comprou'", () => {
    expect(clienteDaLoja(null, undefined)).toEqual({ historico_de_pedidos: "indisponivel" });
  });

  describe("no turno", () => {
    const original = { ...config.crm };
    beforeEach(() => {
      config.crm.url = "http://crm.local";
      config.crm.segredo = "segredo-de-teste-123456";
      setBuscarHistoricoCliente(async () => pedidos);
    });
    afterEach(() => {
      Object.assign(config.crm, original);
      setBuscarHistoricoCliente(async () => {
        throw new Error("CRM desligado nos testes");
      });
    });

    it("o estado do prompt traz os pedidos do cliente", async () => {
      let system = "";
      const llm: LLMProvider = {
        async chat(params: { system: string }): Promise<LLMResponse> {
          system = params.system;
          return endTurn("Oi, Ana!");
        },
      } as LLMProvider;
      await runTurn("oi", createInitialState("5583999990000"), llm, new MockBrindeMeClient(), new Logger("t-ctx"));
      expect(system).toContain('"ja_cliente": true');
      expect(system).toContain("PED-0004");
    });
  });
});
