import { afterEach, describe, expect, it } from "vitest";
import { createInitialState } from "../src/agent/state.js";
import { setEncaminharParaDesign, type PedidoDesign } from "../src/integrations/crm/design.js";
import { MENSAGEM_ENCAMINHADO, encaminharDesignHandler } from "../src/tools/encaminharDesign.js";
import type { BrindeMeClient } from "../src/integrations/brindeme/client.js";

const client = {} as BrindeMeClient;
const arquivos = [
  { nome: "uniforme.jpg", caminho: "/tmp/uniforme.jpg", mime: "image/jpeg", bytes: 2048 },
  { nome: "logo.png", caminho: "/tmp/logo.png", mime: "image/png", bytes: 1024 },
];

function estado(comArquivos = true) {
  const s = createInitialState("5511900000000");
  s.canal = "whatsapp";
  if (comArquivos) s.arquivosRecebidos = [...arquivos];
  return s;
}

const pedidos: PedidoDesign[] = [];
function crmOk() {
  setEncaminharParaDesign(async (p) => {
    pedidos.push(p);
    return { jobId: "job-1", imagens: p.arquivos.length };
  });
}

afterEach(() => {
  pedidos.length = 0;
  setEncaminharParaDesign(async () => {
    throw new Error("CRM desligado nos testes");
  });
});

describe("encaminhar_design", () => {
  it("manda ao CRM a origem LIA, o telefone, o motivo, a observação e todos os arquivos recebidos", async () => {
    crmOk();
    const r = await encaminharDesignHandler({ motivo: "referencia_uniforme", observacao: "camisa igual com a logo da escola" }, estado(), client);
    expect(r).toEqual({ status: "encaminhado", mensagem: MENSAGEM_ENCAMINHADO });
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toMatchObject({
      origem: "LIA",
      telefone: "5511900000000",
      motivo: "referencia_uniforme",
      observacao: "camisa igual com a logo da escola",
      arquivos,
    });
  });

  it("CRM fora devolve erro com a instrução de transferir e não mexe nos arquivos", async () => {
    const s = estado();
    const r = await encaminharDesignHandler({ motivo: "criacao_de_arte" }, s, client);
    expect(r.status).toBe("erro");
    expect(r.mensagem).toBeTruthy();
    expect(r.instrucao).toContain("transferir_humano");
    expect(s.arquivosRecebidos).toEqual(arquivos);
  });

  it("chamada repetida no mesmo turno chama o CRM de novo e responde igual", async () => {
    crmOk();
    const s = estado();
    const a = await encaminharDesignHandler({ motivo: "ajuste_de_arte" }, s, client);
    const b = await encaminharDesignHandler({ motivo: "ajuste_de_arte" }, s, client);
    expect(pedidos).toHaveLength(2);
    expect(b).toEqual(a);
  });

  it("sem arquivos e fora do WhatsApp ainda encaminha", async () => {
    crmOk();
    const s = createInitialState("5511900000000");
    const r = await encaminharDesignHandler({ motivo: "criacao_de_arte" }, s, client);
    expect(r.status).toBe("encaminhado");
    expect(pedidos[0].arquivos).toEqual([]);
  });
});
