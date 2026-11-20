import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservadorCrm } from "../src/whatsapp/crm.js";

describe("ObservadorCrm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("com o CRM fora, áudios além de 50 MB na fila descartam os mais antigos", async () => {
    vi.useFakeTimers();
    let fora = true;
    const ids: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (fora) throw new Error("ECONNREFUSED");
        ids.push(JSON.parse(String(init.body)).id);
        return new Response("{}", { status: 200 });
      })
    );
    const logs: Array<Record<string, unknown>> = [];
    const obs = new ObservadorCrm("http://crm", "s".repeat(16), async () => null, (e) => logs.push(e));
    const vinte = "A".repeat(20 * 1024 * 1024);
    const audio = (id: string) => obs.midia({ id, telefone: "5583999990000", mime: "audio/ogg", base64: vinte, transcricao: null, status: "NAO_TRANSCRITO" });
    audio("a1");
    await vi.advanceTimersByTimeAsync(0); // 1º envio falha: o a1 fica parado na fila, sem envio em curso
    audio("a2");
    audio("a3");
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.filter((l) => l.type === "crm_midia_descartada").map((l) => l.id)).toEqual(["a1"]);
    expect(JSON.stringify(logs)).not.toContain("AAAA");
    fora = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ids).toEqual(["a2", "a3"]);
  });

  it("o áudio que está sendo enviado não é descartado: sai o próximo mais antigo", async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    let liberar!: () => void;
    const primeiro = new Promise<void>((r) => (liberar = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const id = JSON.parse(String(init.body)).id;
        if (id === "a1") await primeiro;
        ids.push(id);
        return new Response("{}", { status: 200 });
      })
    );
    const logs: Array<Record<string, unknown>> = [];
    const obs = new ObservadorCrm("http://crm", "s".repeat(16), async () => null, (e) => logs.push(e));
    const vinte = "A".repeat(20 * 1024 * 1024);
    for (const id of ["a1", "a2", "a3"]) obs.midia({ id, telefone: "5583999990000", mime: "audio/ogg", base64: vinte, transcricao: null, status: "NAO_TRANSCRITO" });
    expect(logs.filter((l) => l.type === "crm_midia_descartada").map((l) => l.id)).toEqual(["a2"]);
    liberar();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ids).toEqual(["a1", "a3"]);
  });

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
