import { createServer, type Server } from "http";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { encaminharParaDesign, setEncaminharParaDesign } from "../src/integrations/crm/design.js";

const SEGREDO = "segredo-de-teste-com-16+";
let servidor: Server;
let status = 200;
let recebido: { url?: string; headers: Record<string, unknown>; corpo: string } = { headers: {}, corpo: "" };
const original = { ...config.crm };
const dir = mkdtempSync(join(tmpdir(), "enc-"));
const a1 = join(dir, "a.png");
const a2 = join(dir, "b.jpg");
writeFileSync(a1, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(a2, Buffer.from([0xff, 0xd8, 0xff]));
const arquivos = [
  { nome: "a.png", caminho: a1, mime: "image/png", bytes: 4 },
  { nome: "b.jpg", caminho: a2, mime: "image/jpeg", bytes: 3 },
];

beforeAll(async () => {
  setEncaminharParaDesign(null); // o setup global põe um falso; aqui vale o real
  servidor = createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on("data", (p) => partes.push(p));
    req.on("end", () => {
      recebido = { url: req.url, headers: req.headers, corpo: Buffer.concat(partes).toString("latin1") };
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { jobId: "j1", criado: true } : { error: "x" }));
    });
  });
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
  const porta = (servidor.address() as { port: number }).port;
  config.crm.url = `http://127.0.0.1:${porta}`;
  config.crm.segredo = SEGREDO;
});
afterAll(() => {
  Object.assign(config.crm, original);
  servidor.close();
});
beforeEach(() => {
  status = 200;
});

describe("encaminharParaDesign", () => {
  it("manda multipart com o segredo, os campos e uma parte por imagem", async () => {
    const r = await encaminharParaDesign({ telefone: "5511900000001", origem: "LIA", motivo: "referencia_uniforme", arquivos });
    expect(r).toEqual({ jobId: "j1", imagens: 2 });
    expect(recebido.url).toBe("/api/integracao/design");
    expect(recebido.headers["x-crm-secret"]).toBe(SEGREDO);
    expect(String(recebido.headers["content-type"])).toMatch(/^multipart\/form-data/);
    expect(recebido.corpo).toContain('name="telefone"');
    expect(recebido.corpo).toContain('name="origem"');
    expect(recebido.corpo).toContain("referencia_uniforme");
    expect(recebido.corpo.match(/name="imagem"/g)).toHaveLength(2);
  });
  it("com mais de 10 arquivos na conversa, manda só os 10 mais recentes", async () => {
    const muitos = Array.from({ length: 12 }, (_, i) => ({ ...arquivos[0], nome: `f${i + 1}.png` }));
    const r = await encaminharParaDesign({ telefone: "5511900000001", origem: "LIA", arquivos: muitos });
    expect(r.imagens).toBe(10);
    expect(recebido.corpo).not.toContain('filename="f2.png"');
    expect(recebido.corpo).toContain('filename="f3.png"');
    expect(recebido.corpo).toContain('filename="f12.png"');
  });
  it("arquivo que sumiu do disco é pulado", async () => {
    const r = await encaminharParaDesign({
      telefone: "5511900000001",
      origem: "LIA",
      arquivos: [...arquivos.slice(0, 1), { nome: "x.png", caminho: join(dir, "nao-existe.png"), mime: "image/png", bytes: 1 }],
    });
    expect(r.imagens).toBe(1);
  });
  it("CRM com erro lança com o status", async () => {
    status = 500;
    await expect(encaminharParaDesign({ telefone: "5511900000001", origem: "LIA", arquivos: [] })).rejects.toThrow(/500/);
  });
  it("CRM sem URL lança 'CRM não configurado'", async () => {
    const url = config.crm.url;
    config.crm.url = "";
    await expect(encaminharParaDesign({ telefone: "5511900000001", origem: "LIA", arquivos: [] })).rejects.toThrow(/CRM não configurado/);
    config.crm.url = url;
  });
});
