import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "../src/agent/state.js";
import { setEncaminharParaDesign, type PedidoDesign } from "../src/integrations/crm/design.js";
import { transferirHumanoHandler } from "../src/tools/transferirHumano.js";
import type { BrindeMeClient } from "../src/integrations/brindeme/client.js";

const client = { listAdmins: async () => [{ id: "a1", name: "Ana", email: "", phone: "" }] } as unknown as BrindeMeClient;
const arquivos = [{ nome: "mockup.png", caminho: "/tmp/mockup.png", mime: "image/png", bytes: 10 }];

function estado() {
  const s = createInitialState("5511900000000");
  s.arquivosRecebidos = [...arquivos];
  return s;
}

const pedidos: PedidoDesign[] = [];
afterEach(() => {
  pedidos.length = 0;
  vi.restoreAllMocks();
  setEncaminharParaDesign(async () => {
    throw new Error("CRM desligado nos testes");
  });
});

describe("transferir_humano encaminha ajustes de arte ao design", () => {
  it.each(["ajuste_mockup", "arte_problematica"] as const)("motivo %s abre job de design com o motivo e a observação", async (motivo) => {
    setEncaminharParaDesign(async (p) => {
      pedidos.push(p);
      return { jobId: "job-1", imagens: 1 };
    });
    const r = await transferirHumanoHandler({ motivo, prioridade: "normal", observacao: "trocar o azul por vermelho" }, estado(), client);
    expect(r.status).toBe("transferido");
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toMatchObject({ origem: "LIA", telefone: "5511900000000", arquivos });
    expect(pedidos[0].observacao).toContain(motivo);
    expect(pedidos[0].observacao).toContain("trocar o azul por vermelho");
  });

  it("motivo desconto não chama o design", async () => {
    setEncaminharParaDesign(async (p) => {
      pedidos.push(p);
      return { jobId: "job-1", imagens: 0 };
    });
    await transferirHumanoHandler({ motivo: "desconto", prioridade: "normal" }, estado(), client);
    expect(pedidos).toHaveLength(0);
  });

  it("CRM fora não muda a transferência e vai para o log", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await transferirHumanoHandler({ motivo: "ajuste_mockup", prioridade: "normal" }, estado(), client);
    expect(r.status).toBe("transferido");
    expect(r.mensagem_cliente).toBeTruthy();
    expect(aviso).toHaveBeenCalled();
  });
});
