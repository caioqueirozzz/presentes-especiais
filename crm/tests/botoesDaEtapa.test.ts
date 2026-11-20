import { describe, expect, it } from "vitest";
import { botoesDaEtapa } from "@/components/design/etapas";

const designer = { souDesigner: true, isAdmin: false, semDesigner: false };
const acoes = (stage: Parameters<typeof botoesDaEtapa>[0], quem = designer) => botoesDaEtapa(stage, quem);

describe("botoesDaEtapa", () => {
  it("Na fila: Começar e Reprocessar IA", () => {
    expect(acoes("NA_FILA")).toEqual(expect.arrayContaining(["comecar", "reprocessar", "cancelar"]));
  });
  it("Em criação: Enviar mockup, sem Cliente aprovou", () => {
    expect(acoes("EM_CRIACAO")).toContain("enviar_mockup");
    expect(acoes("EM_CRIACAO")).not.toContain("cliente_aprovou");
  });
  it("Aguardando cliente: Marcar ajustes e Cliente aprovou", () => {
    expect(acoes("AGUARDANDO_CLIENTE")).toEqual(expect.arrayContaining(["ajustes", "cliente_aprovou", "devolver", "cancelar"]));
  });
  it("Aprovado e Cancelado não têm ações", () => {
    expect(acoes("APROVADO")).toEqual([]);
    expect(acoes("CANCELADO")).toEqual([]);
  });
  it("Aprovado ou Cancelado com a conversa ainda no designer (a ponte falhou): só Devolver", () => {
    expect(botoesDaEtapa("APROVADO", { ...designer, conversaComDesigner: true })).toEqual(["devolver"]);
    expect(botoesDaEtapa("CANCELADO", { ...designer, conversaComDesigner: true })).toEqual(["devolver"]);
  });
  it("Assumir só para designer em job sem designer, e então nada mais", () => {
    expect(acoes("NA_FILA", { souDesigner: true, isAdmin: false, semDesigner: true })).toEqual(["assumir"]);
    expect(acoes("NA_FILA", { souDesigner: false, isAdmin: true, semDesigner: true })).not.toContain("assumir");
  });
  it("quem não é o designer nem admin não vê ações", () => {
    expect(acoes("EM_CRIACAO", { souDesigner: false, isAdmin: false, semDesigner: false })).toEqual([]);
  });
  it("Cancelar em toda etapa aberta", () => {
    for (const s of ["RECEBIDO", "PROCESSANDO_IA", "NA_FILA", "EM_CRIACAO", "AGUARDANDO_CLIENTE", "AJUSTES"] as const) {
      expect(acoes(s)).toContain("cancelar");
    }
  });
});
