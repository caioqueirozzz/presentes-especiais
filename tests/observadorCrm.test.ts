import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservadorCrm } from "../src/whatsapp/crm.js";

describe("ObservadorCrm", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("o áudio vai a /midias depois da mensagem do mesmo id, na mesma fila", async () => {
    const rotas: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        rotas.push(`${url.split("/").pop()}:${JSON.parse(String(init.body)).id}`);
        return new Response("{}", { status: 200 });
      })
    );
    const obs = new ObservadorCrm("http://crm", "s".repeat(16), async () => null, () => {});
    obs.mensagem({ id: "a1", telefone: "5583999990000", autor: "CLIENTE", tipo: "audio", texto: "", timestamp: "2026-11-18T10:00:00Z" });
    obs.midia({ id: "a1", telefone: "5583999990000", mime: "audio/ogg", base64: "T2dnUw==", transcricao: "oi", status: "OK" });
    await vi.waitFor(() => expect(rotas).toEqual(["mensagens:a1", "midias:a1"]));
  });
});
