import { describe, expect, it } from "vitest";
import { addMessage, createInitialState } from "../src/agent/state.js";
import { MockBrindeMeClient } from "../src/integrations/brindeme/mockClient.js";
import { iniciarNovoPedidoHandler } from "../src/tools/iniciarNovoPedido.js";

const client = new MockBrindeMeClient();

describe("iniciar_novo_pedido e a arte do turno", () => {
  it("mantém a arte que veio na mensagem atual e limpa a do pedido anterior", async () => {
    const state = createInitialState("5583999990000");
    state.canal = "whatsapp";
    state.produtosDiscutidos = ["p-antigo"];
    state.arquivosRecebidos = [
      { nome: "arquivo-VELHO001.jpg", caminho: "/tmp/velho.jpg", mime: "image/jpeg", bytes: 4000 },
      { nome: "arquivo-E295BC94.jpg", caminho: "/tmp/novo.jpg", mime: "image/jpeg", bytes: 5000 },
    ];
    state.artes = [
      { ref: "arte-velha", arquivo: "/tmp/velho.jpg" },
      { ref: "arte-nova", arquivo: "/tmp/novo.jpg", posicao: "frente" },
    ];
    addMessage(state, "user", "[ARQUIVO recebido: arquivo-E295BC94.jpg (image/jpeg, 5 KB)]" + "\n" + "quero essa logo gravada em 50 canecas");

    const r = (await iniciarNovoPedidoHandler({ o_que_procura: "50 canecas com logo" }, state, client)) as { status: string };
    expect(r.status).toBe("novo_pedido_iniciado");
    expect(state.artes.map((a) => a.ref)).toEqual(["arte-nova"]);
  });

  it("sem arquivo na mensagem atual, limpa todas as artes como antes", async () => {
    const state = createInitialState("5583999990000");
    state.produtosDiscutidos = ["p-antigo"];
    state.artes = [{ ref: "arte-velha", arquivo: "/tmp/velho.jpg" }];
    addMessage(state, "user", "quero fazer um pedido novo de canecas");
    await iniciarNovoPedidoHandler({}, state, client);
    expect(state.artes).toEqual([]);
  });
});
