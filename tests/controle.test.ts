import { createServer, type Server } from "http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { arquivosDaConversa, tratadorControle } from "../src/whatsapp/controle.js";
import type { Ponte } from "../src/whatsapp/ponte.js";
import type { CanalWwebjs } from "../src/whatsapp/sessao.js";
import type { ArmazemModoLia } from "../src/whatsapp/modoLia.js";
import { setEncaminharParaDesign, type PedidoDesign } from "../src/integrations/crm/design.js";
import type { ArquivoRecebido } from "../src/agent/state.js";

const SEGREDO = "segredo-de-teste-com-16+";
let estado = "CONECTADO";
const canal = {
  situacao: () => ({ estado }),
  enviarImagemParaTelefone: vi.fn(async () => "id-midia"),
  enviarTexto: vi.fn(async () => "id-texto"),
  enviarImagem: vi.fn(async () => {}),
  enviar: vi.fn(async () => {}),
};
const devolverParaIa = vi.fn(async () => {});
let arquivos: ArquivoRecebido[] = [];
let pedidos: PedidoDesign[] = [];
let crmFora = false;
let servidor: Server;
let base = "";

beforeAll(async () => {
  servidor = createServer(
    tratadorControle({
      porta: 0,
      segredo: SEGREDO,
      canal: canal as unknown as CanalWwebjs,
      ponte: { devolverParaIa } as unknown as Ponte,
      lia: {} as ArmazemModoLia,
      log: () => {},
      lerArquivos: async () => arquivos,
    })
  );
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(servidor.address() as { port: number }).port}`;
});
afterAll(() => {
  servidor.close();
  setEncaminharParaDesign(async () => {
    throw new Error("CRM desligado nos testes");
  });
});
beforeEach(() => {
  estado = "CONECTADO";
  arquivos = [];
  pedidos = [];
  crmFora = false;
  vi.clearAllMocks();
  setEncaminharParaDesign(async (p) => {
    if (crmFora) throw new Error("fora");
    pedidos.push(p);
    return { jobId: "j1", imagens: p.arquivos.length };
  });
});

const post = (rota: string, corpo: unknown, segredo = SEGREDO) =>
  fetch(`${base}${rota}`, { method: "POST", headers: { "x-ponte-secret": segredo, "Content-Type": "application/json" }, body: JSON.stringify(corpo) });

describe("/enviar-midia", () => {
  const valido = { telefone: "55 (11) 90000-0001", url: "https://cdn.exemplo.com/a.png", legenda: "Segue a arte" };
  it("sem segredo → 401", async () => {
    expect((await post("/enviar-midia", valido, "errado-errado-errado")).status).toBe(401);
  });
  it.each([
    ["telefone curto", { ...valido, telefone: "123" }],
    ["sem url", { ...valido, url: undefined }],
    ["url ftp", { ...valido, url: "ftp://x/a.png" }],
    ["url http externa", { ...valido, url: "http://exemplo.com/a.png" }],
    ["legenda longa", { ...valido, legenda: "x".repeat(1001) }],
  ])("%s → 400", async (_, corpo) => {
    expect((await post("/enviar-midia", corpo)).status).toBe(400);
    expect(canal.enviarImagemParaTelefone).not.toHaveBeenCalled();
  });
  it("WhatsApp desconectado → 409", async () => {
    estado = "RECONECTANDO";
    expect((await post("/enviar-midia", valido)).status).toBe(409);
  });
  it("mesma chave em 2 min: envia uma vez e devolve o mesmo id", async () => {
    const corpo = { ...valido, chave: "mockup:job-a:1" };
    const [a, b] = await Promise.all([post("/enviar-midia", corpo), post("/enviar-midia", corpo)]);
    expect(await a.json()).toEqual({ id: "id-midia" });
    expect(await b.json()).toEqual({ id: "id-midia" });
    expect(canal.enviarImagemParaTelefone).toHaveBeenCalledTimes(1);
  });
  it("mesma chave com legenda trocada envia de novo", async () => {
    await post("/enviar-midia", { ...valido, chave: "mockup:job-c:1", legenda: "legenda errada" });
    await post("/enviar-midia", { ...valido, chave: "mockup:job-c:1", legenda: "legenda certa" });
    expect(canal.enviarImagemParaTelefone).toHaveBeenCalledTimes(2);
  });
  it("envio que falhou libera a chave para a nova tentativa", async () => {
    const corpo = { ...valido, chave: "mockup:job-b:1" };
    canal.enviarImagemParaTelefone.mockRejectedValueOnce(new Error("caiu"));
    expect((await post("/enviar-midia", corpo)).status).toBeGreaterThanOrEqual(500);
    expect((await post("/enviar-midia", corpo)).status).toBe(200);
    expect(canal.enviarImagemParaTelefone).toHaveBeenCalledTimes(2);
  });
  it.each(["https://cdn.exemplo.com/a.png", "http://127.0.0.1:3200/api/design/arquivo?chave=x", "http://localhost:3200/x"])(
    "válido (%s) → 200, envio como atendente",
    async (url) => {
      const res = await post("/enviar-midia", { ...valido, url });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "id-midia" });
      expect(canal.enviarImagemParaTelefone).toHaveBeenCalledWith("5511900000001", url, "Segue a arte");
      // Fora do registro de saída: nenhum outro caminho de envio da Lia é usado
      expect(canal.enviarImagem).not.toHaveBeenCalled();
      expect(canal.enviar).not.toHaveBeenCalled();
    }
  );
});

describe("arquivosDaConversa", () => {
  it("lê do estado gravado e tolera documento ausente ou estranho", () => {
    const a = { nome: "a.png", caminho: "/x/a.png", mime: "image/png", bytes: 1 };
    expect(arquivosDaConversa({ estado: { arquivosRecebidos: [a], telefone: "x" }, turnos: [] })).toEqual([a]);
    expect(arquivosDaConversa({ estado: {} })).toEqual([]);
    expect(arquivosDaConversa(null)).toEqual([]);
    expect(arquivosDaConversa({ estado: { arquivosRecebidos: "x" } })).toEqual([]);
  });
});

describe("/encaminhar-design", () => {
  it("manda os arquivos recebidos com origem VENDEDOR", async () => {
    arquivos = [
      { nome: "a.png", caminho: "/x/a.png", mime: "image/png", bytes: 1 },
      { nome: "b.png", caminho: "/x/b.png", mime: "image/png", bytes: 1 },
    ];
    const res = await post("/encaminhar-design", { telefone: "5511900000001", requested_by: "u-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: "j1", imagens: 2 });
    expect(pedidos[0]).toMatchObject({ telefone: "5511900000001", origem: "VENDEDOR", requestedBy: "u-1" });
  });
  it("sem arquivos chama com lista vazia", async () => {
    await post("/encaminhar-design", { telefone: "5511900000001" });
    expect(pedidos[0].arquivos).toEqual([]);
  });
  it("telefone inválido → 400", async () => {
    expect((await post("/encaminhar-design", { telefone: "12" })).status).toBe(400);
  });
  it("CRM fora → 502", async () => {
    crmFora = true;
    const res = await post("/encaminhar-design", { telefone: "5511900000001" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { erro?: string }).erro).toBeTruthy();
  });
});

describe("/devolver", () => {
  it("repassa à ponte só os ids de mensagem válidos em consumidas", async () => {
    const r = await post("/devolver", { telefone: "5511900000001", consumidas: ["w-1", 42, "x".repeat(201), "w-2"] });
    expect(r.status).toBe(200);
    expect(devolverParaIa).toHaveBeenCalledWith("5511900000001", undefined, ["w-1", "w-2"]);
  });
  it("sem consumidas devolve com lista vazia", async () => {
    await post("/devolver", { telefone: "5511900000001", nota: "pagou" });
    expect(devolverParaIa).toHaveBeenCalledWith("5511900000001", "pagou", []);
  });
});
