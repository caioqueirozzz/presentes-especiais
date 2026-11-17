import { describe, it, expect } from "vitest";
import { MockBrindeMeClient } from "../src/integrations/brindeme/mockClient.js";
import { registrarArteHandler } from "../src/tools/registrarArte.js";
import { addMessage, createInitialState } from "../src/agent/state.js";

describe("registrarArte", () => {
  const client = new MockBrindeMeClient();

  it("aceita PNG e salva no estado", async () => {
    const state = createInitialState("5583999990000");
    const result = await registrarArteHandler({ descricao_arquivo: "logo.png" }, state, client) as { status: string; arte_ref: string };
    expect(result.status).toBe("arte_registrada");
    expect(state.artes).toHaveLength(1);
    expect(state.artes[0].arquivo).toBe("logo.png");
  });

  it("rejeita .exe com formatos aceitos", async () => {
    const state = createInitialState("5583999990000");
    const result = await registrarArteHandler({ descricao_arquivo: "malware.exe" }, state, client) as { erro: string; formatos_aceitos: string };
    expect(result.erro).toBe("formato_nao_aceito");
    expect(result.formatos_aceitos).toContain("png");
    expect(state.artes).toHaveLength(0);
  });

  it("aceita PDF", async () => {
    const state = createInitialState("5583999990000");
    const result = await registrarArteHandler({ descricao_arquivo: "arte.pdf" }, state, client) as { status: string };
    expect(result.status).toBe("arte_registrada");
  });

  it("rejeita arquivo sem extensão", async () => {
    const state = createInitialState("5583999990000");
    const result = await registrarArteHandler({ descricao_arquivo: "semextensao" }, state, client) as { erro: string };
    expect(result.erro).toBe("formato_nao_aceito");
  });

  describe("nome errado pelo WhatsApp", () => {
    const antigo = { nome: "arquivo-AAAA0001.jpg", caminho: "/tmp/antigo.jpg", mime: "image/jpeg", bytes: 4000 };
    const novo = { nome: "arquivo-B8DCF53F.jpg", caminho: "/tmp/novo.jpg", mime: "image/jpeg", bytes: 5000 };
    function noWhatsapp(ultima: string) {
      const state = createInitialState("5583999990000");
      state.canal = "whatsapp";
      state.arquivosRecebidos = [antigo, novo];
      addMessage(state, "user", ultima);
      return state;
    }

    it("com um só arquivo na última mensagem, registra esse arquivo mesmo com o nome inventado", async () => {
      const state = noWhatsapp("[ARQUIVO recebido: arquivo-B8DCF53F.jpg (image/jpeg, 5 KB)]" + "\n" + "quero essa logo gravada em 50 canecas");
      const r = (await registrarArteHandler({ descricao_arquivo: "logo-empresa.jpg" }, state, client)) as { status: string; arquivo: string };
      expect(r.status).toBe("arte_registrada");
      expect(r.arquivo).toBe("arquivo-B8DCF53F.jpg");
      expect(state.artes[0].arquivo).toBe("/tmp/novo.jpg");
    });

    it("com dois arquivos na última mensagem, continua pedindo o nome certo", async () => {
      const state = noWhatsapp("[ARQUIVO recebido: arquivo-AAAA0001.jpg (image/jpeg, 4 KB)]" + "\n" + "[ARQUIVO recebido: arquivo-B8DCF53F.jpg (image/jpeg, 5 KB)]");
      const r = (await registrarArteHandler({ descricao_arquivo: "logo-empresa.jpg" }, state, client)) as { erro: string };
      expect(r.erro).toBe("arquivo_nao_recebido");
      expect(state.artes).toHaveLength(0);
    });

    it("sem arquivo na última mensagem, continua pedindo o arquivo", async () => {
      const state = noWhatsapp("quero essa logo gravada em 50 canecas");
      const r = (await registrarArteHandler({ descricao_arquivo: "logo-empresa.jpg" }, state, client)) as { erro: string };
      expect(r.erro).toBe("arquivo_nao_recebido");
    });
  });
});
