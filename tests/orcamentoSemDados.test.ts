import { describe, it, expect, afterEach } from "vitest";
import { runTurn } from "../src/agent/runTurn.js";
import { createInitialState } from "../src/agent/state.js";
import { MockBrindeMeClient } from "../src/integrations/brindeme/mockClient.js";
import { Logger } from "../src/logging/logger.js";
import { setProductIndexStore, setOccasionTagStore } from "../src/tools/buscarProdutos.js";
import { usarIndiceDoMock } from "./helpers/catalogo.js";
import { ScriptedLLM, endTurn, toolUse } from "./helpers/llmRoteirizado.js";

const preparar = (email: string) =>
  toolUse("preparar_orcamento", { tipo: "PF", nome: "Cliente", email, itens: [{ subproduto_id: "sub-001-branco", quantidade: 50 }] });

describe("preparar_orcamento só com o e-mail que o cliente deu (eval 39)", () => {
  afterEach(() => {
    setProductIndexStore(null);
    setOccasionTagStore(null);
  });

  it("e-mail que o cliente não escreveu: não prepara e manda pedir os dados", async () => {
    await usarIndiceDoMock();
    const state = createInitialState("5583999990000");
    const llm = new ScriptedLLM([
      toolUse("buscar_produtos", { consulta: "caneca", quantidade: 50 }),
      preparar("cliente@example.com"),
      endTurn("Me passa seu nome e e-mail?"),
    ]);
    await runTurn("Quero orçamento de 50 canecas brancas", state, llm, new MockBrindeMeClient(), new Logger(state.conversaId));
    const resultado = JSON.stringify(llm.seen[2].at(-1));
    expect(resultado).toContain("dados_nao_informados");
    expect(state.fichaPedido).toBeUndefined();
    expect(state.cliente.email).toBeUndefined();
  });

  it("e-mail que só aparece dentro de outro (ana@x.com em banana@x.com): não conta", async () => {
    await usarIndiceDoMock();
    const state = createInitialState("5583999990000");
    const llm = new ScriptedLLM([
      toolUse("buscar_produtos", { consulta: "caneca", quantidade: 50 }),
      preparar("ana@x.com"),
      endTurn("Me passa seu e-mail?"),
    ]);
    await runTurn("50 canecas brancas, PF, Banana, banana@x.com", state, llm, new MockBrindeMeClient(), new Logger(state.conversaId));
    expect(JSON.stringify(llm.seen[2].at(-1))).toContain("dados_nao_informados");
    expect(state.fichaPedido).toBeUndefined();
  });

  it("e-mail escrito pelo cliente (em qualquer mensagem, sem caixa): prepara", async () => {
    await usarIndiceDoMock();
    const state = createInitialState("5583999990000");
    const llm = new ScriptedLLM([
      toolUse("buscar_produtos", { consulta: "caneca", quantidade: 50 }),
      preparar("joao@teste.com"),
      endTurn("Resumo. Posso enviar?"),
    ]);
    await runTurn("50 canecas brancas, PF, João, JOAO@teste.com", state, llm, new MockBrindeMeClient(), new Logger(state.conversaId));
    expect(state.fichaPedido).toBeDefined();
    expect(state.cliente.email).toBe("joao@teste.com");
  });

  it("e-mail seguido de pontuação (ana@x.com? / [ana@x.com]!): conta", async () => {
    await usarIndiceDoMock();
    const state = createInitialState("5583999990000");
    const llm = new ScriptedLLM([
      toolUse("buscar_produtos", { consulta: "caneca", quantidade: 50 }),
      preparar("ana@x.com"),
      endTurn("Resumo. Posso enviar?"),
    ]);
    await runTurn("50 canecas brancas, PF, Ana, [ana@x.com]! serve ana@x.com?", state, llm, new MockBrindeMeClient(), new Logger(state.conversaId));
    expect(state.fichaPedido).toBeDefined();
  });
});
