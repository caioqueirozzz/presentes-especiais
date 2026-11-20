import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AgenteDefinitivo } from "../src/api/agenteDefinitivo.js";
import { RepositorioConversas } from "../src/conversas/repositorio.js";
import { pedido } from "./helpers/bateriaContrato.js";
import { runTurn } from "../src/agent/runTurn.js";
import { createInitialState } from "../src/agent/state.js";
import { MockBrindeMeClient } from "../src/integrations/brindeme/mockClient.js";
import { Logger } from "../src/logging/logger.js";
import { itensDosCartoes } from "../src/tools/cartao.js";
import { respostaMensagensSchema } from "../src/contrato/esquemas.js";
import { setProductIndexStore, setOccasionTagStore } from "../src/tools/buscarProdutos.js";
import { usarIndiceDoMock } from "./helpers/catalogo.js";
import { ScriptedLLM, endTurn, toolUse } from "./helpers/llmRoteirizado.js";

describe("cartões no turno", () => {
  afterEach(() => {
    setProductIndexStore(null);
    setOccasionTagStore(null);
  });

  it("buscar_produtos devolve os cartões no TurnResult, e o histórico guarda o que o cliente viu", async () => {
    await usarIndiceDoMock();
    const state = createInitialState("5583999990000");
    const llm = new ScriptedLLM([toolUse("buscar_produtos", { consulta: "caneca", quantidade: 50 }), endTurn("Qual delas te agrada?")]);
    const r = await runTurn("quero 50 canecas", state, llm, new MockBrindeMeClient(), new Logger(state.conversaId));
    expect(r.response).toBe("Qual delas te agrada?");
    expect(r.cartoes?.length).toBeGreaterThan(0);
    expect(r.cartoes![0].legenda).toMatch(/^\*Caneca de Porcelana Personalizada\*/);
    const ultima = state.historico.at(-1)!;
    expect(ultima.role).toBe("assistant");
    expect(ultima.content.startsWith(r.cartoes![0].legenda)).toBe(true);
    expect(ultima.content.endsWith("Qual delas te agrada?")).toBe(true);
  });

  it("o modelo não recebe a legenda nem a foto dos cartões: só sabe que foram enviados (eval 35)", async () => {
    await usarIndiceDoMock();
    const state = createInitialState("5583999990000");
    const llm = new ScriptedLLM([toolUse("buscar_produtos", { consulta: "caneca", quantidade: 50 }), endTurn("Qual cor?")]);
    const r = await runTurn("quero 50 canecas", state, llm, new MockBrindeMeClient(), new Logger(state.conversaId));
    const resultado = JSON.stringify(llm.seen[1].at(-1));
    expect(r.cartoes!.length).toBeGreaterThan(0);
    expect(resultado).not.toContain("/un");
    expect(resultado).not.toContain(r.cartoes![0].imagem_url!);
    expect(resultado).toContain("cartoes_enviados");
    // O preço unitário está no cartão: à vista, o modelo o redigitava. O total fica, para quando o cliente perguntar.
    expect(resultado).not.toMatch(/preco_unitario_na_quantidade|18\.9/);
    expect(resultado).not.toContain("total_estimado");
    expect(resultado).toContain('\\"total_se_o_cliente_perguntar\\":945');
    expect(resultado).toContain("sub-001-branco");
  });

  it("cores com preço diferente: o total que o modelo recebe leva a cor cotada", async () => {
    await usarIndiceDoMock();
    const client = new MockBrindeMeClient();
    const original = client.precoVenda.bind(client);
    client.precoVenda = async (id, qs) => new Map([...(await original(id, qs))].map(([q, v]) => [q, id === "sub-001-preto" ? v + 100 : v]));
    const state = createInitialState("5583999990000");
    const llm = new ScriptedLLM([toolUse("buscar_produtos", { consulta: "caneca", quantidade: 50 }), endTurn("Qual cor?")]);
    await runTurn("quero 50 canecas", state, llm, client, new Logger(state.conversaId));
    expect(JSON.stringify(llm.seen[1].at(-1))).toContain('total_vale_so_para_a_cor\\":\\"Branco');
  });

  it("detalhar_produto: o modelo não recebe o preço por cor, que está no cartão", async () => {
    await usarIndiceDoMock();
    const state = createInitialState("5583999990000");
    const llm = new ScriptedLLM([toolUse("detalhar_produto", { produto_id: "prod-001", quantidade: 50 }), endTurn("Qual cor?")]);
    const r = await runTurn("me fala da caneca, 50 un", state, llm, new MockBrindeMeClient(), new Logger(state.conversaId));
    const resultado = JSON.stringify(llm.seen[1].at(-1));
    expect(r.cartoes![0].legenda).toMatch(/18,90/);
    expect(resultado).not.toMatch(/preco_para_quantidade|18\.9/);
    expect(resultado).toContain("sub-001-branco");
    expect(resultado).toContain("cores_que_atendem_quantidade");
  });

  it("buscar de novo troca os cartões; detalhar acrescenta ou substitui o do mesmo produto", async () => {
    await usarIndiceDoMock();
    const state = createInitialState("5583999990000");
    const llm = new ScriptedLLM([
      toolUse("buscar_produtos", { consulta: "caneca", quantidade: 50 }),
      toolUse("buscar_produtos", { consulta: "garrafa", quantidade: 50 }),
      toolUse("detalhar_produto", { produto_id: "prod-003", quantidade: 50 }),
      endTurn("Essa é a garrafa."),
    ]);
    const r = await runTurn("quero 50 garrafas", state, llm, new MockBrindeMeClient(), new Logger(state.conversaId));
    expect(r.cartoes!.filter((c) => c.produto_id === "prod-003")).toHaveLength(1);
    expect(r.cartoes!.some((c) => c.produto_id === "prod-001")).toBe(false);
  });

  it("Foco da revisão 2: cartão sem imagem ou com URL inválida vira texto; com URL https, foto", () => {
    const itens = itensDosCartoes([
      { produto_id: "a", imagem_url: "https://cdn.brinde.me/a.webp", legenda: "A" },
      { produto_id: "b", imagem_url: null, legenda: "B" },
      { produto_id: "c", imagem_url: "/storage/c.webp", legenda: "C" },
    ]);
    expect(itens).toEqual([{ imagem_url: "https://cdn.brinde.me/a.webp", legenda: "A" }, "B", "C"]);
    expect(respostaMensagensSchema.parse({ respostas: [...itens, "texto"], modo: "ia" }).respostas).toHaveLength(4);
  });

  it("AgenteDefinitivo: turno normal com buscar_produtos devolve o cartão antes do texto", async () => {
    await usarIndiceDoMock();
    const repo = new RepositorioConversas(mkdtempSync(join(tmpdir(), "conversas-")));
    const llm = new ScriptedLLM([toolUse("buscar_produtos", { consulta: "caneca", quantidade: 50 }), endTurn("Qual delas te agrada?")]);
    const agente = new AgenteDefinitivo({ repo, llm, client: new MockBrindeMeClient(), tetoMs: 90_000, respostasPorHora: 30 });
    const r = await agente.processarLote(pedido("5583999990000", ["r1"]));
    expect(r.modo).toBe("ia");
    expect(r.respostas.at(-1)).toBe("Qual delas te agrada?");
    const primeiro = r.respostas[0];
    const legenda = typeof primeiro === "string" ? primeiro : primeiro.legenda;
    expect(legenda).toMatch(/^\*Caneca de Porcelana Personalizada\*/);
  });
});
