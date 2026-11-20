import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { one, query } from "@/lib/db";
import { DesignError, abrirOuAnexar, atribuirDesigner, mudarEtapa, podeTransitar } from "@/lib/design";
import type { Etapa } from "@/lib/design";
import { criarLead, criarUsuario, limparBanco } from "./banco";

const PNG = { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), nome: "ref.png" };
const PDF = { bytes: Buffer.from("%PDF-1.4"), nome: "logo.pdf" };
const job = (id: string) =>
  one<{ stage: Etapa; ia_status: string; designer_id: string | null; ia_tentativas: number }>("SELECT * FROM design_jobs WHERE id = $1", [id]);

beforeAll(() => {
  process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "arq-"));
});
beforeEach(limparBanco);

describe("transições", () => {
  const abertas: Etapa[] = ["RECEBIDO", "PROCESSANDO_IA", "NA_FILA", "EM_CRIACAO", "AGUARDANDO_CLIENTE", "AJUSTES"];
  const permitidas: Array<[Etapa, Etapa]> = [
    ["RECEBIDO", "PROCESSANDO_IA"],
    ["RECEBIDO", "NA_FILA"],
    ["PROCESSANDO_IA", "NA_FILA"],
    ["NA_FILA", "PROCESSANDO_IA"],
    ["NA_FILA", "EM_CRIACAO"],
    ["EM_CRIACAO", "AGUARDANDO_CLIENTE"],
    ["AJUSTES", "AGUARDANDO_CLIENTE"],
    ["AGUARDANDO_CLIENTE", "AJUSTES"],
    ["AGUARDANDO_CLIENTE", "APROVADO"],
    ...abertas.map((e) => [e, "CANCELADO"] as [Etapa, Etapa]),
  ];
  it.each(permitidas)("%s → %s permitida", (de, para) => expect(podeTransitar(de, para)).toBe(true));
  const invalidas: Array<[Etapa, Etapa]> = [
    ["RECEBIDO", "EM_CRIACAO"],
    ["PROCESSANDO_IA", "EM_CRIACAO"],
    ["NA_FILA", "AGUARDANDO_CLIENTE"],
    ["EM_CRIACAO", "APROVADO"],
    ["AGUARDANDO_CLIENTE", "EM_CRIACAO"],
    ["AJUSTES", "APROVADO"],
    ["APROVADO", "CANCELADO"],
    ["CANCELADO", "NA_FILA"],
  ];
  it.each(invalidas)("%s → %s recusada", (de, para) => expect(podeTransitar(de, para)).toBe(false));

  it("mudarEtapa inválida lança DesignError e não grava", async () => {
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    await expect(mudarEtapa(jobId, "AJUSTES", null)).rejects.toBeInstanceOf(DesignError);
    expect((await job(jobId))!.stage).toBe("NA_FILA");
  });
  it("mudarEtapa pública recusa APROVADO e AGUARDANDO_CLIENTE", async () => {
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    await mudarEtapa(jobId, "EM_CRIACAO", null);
    await expect(mudarEtapa(jobId, "AGUARDANDO_CLIENTE", null)).rejects.toBeInstanceOf(DesignError);
    await expect(mudarEtapa(jobId, "APROVADO", null)).rejects.toBeInstanceOf(DesignError);
  });
});

describe("abrirOuAnexar", () => {
  it("com imagem analisável vai para PROCESSANDO_IA e grava o original", async () => {
    const lead = await criarLead();
    const r = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [PNG], motivo: "referencia_uniforme" });
    expect(r.criado).toBe(true);
    expect((await job(r.jobId))!.stage).toBe("PROCESSANDO_IA");
    const assets = await query<{ tipo: string; arquivo: string }>("SELECT tipo, arquivo FROM design_assets WHERE job_id = $1", [r.jobId]);
    expect(assets).toHaveLength(1);
    expect(assets[0].tipo).toBe("ORIGINAL");
    expect(assets[0].arquivo.startsWith(`design/${r.jobId}/original-`)).toBe(true);
    expect(assets[0].arquivo.endsWith(".png")).toBe(true);
  });
  it("sem imagem analisável vai para NA_FILA com SEM_IMAGEM", async () => {
    const lead = await criarLead();
    const r = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [PDF] });
    const j = (await job(r.jobId))!;
    expect([j.stage, j.ia_status]).toEqual(["NA_FILA", "SEM_IMAGEM"]);
  });
  it("arquivo com tipo inválido é recusado inteiro", async () => {
    const lead = await criarLead();
    await expect(
      abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [{ bytes: Buffer.from("MZ"), nome: "x.png" }] })
    ).rejects.toBeInstanceOf(DesignError);
    expect((await query("SELECT 1 FROM design_jobs")).length).toBe(0);
  });
  it("imagem nova em job não assumido volta para PROCESSANDO_IA e zera tentativas", async () => {
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    await query("UPDATE design_jobs SET ia_tentativas = 2 WHERE id = $1", [jobId]);
    const r = await abrirOuAnexar({ leadId: lead, origem: "LIA", imagens: [PNG] });
    expect(r).toEqual({ jobId, criado: false });
    const j = (await job(jobId))!;
    expect([j.stage, j.ia_tentativas]).toEqual(["PROCESSANDO_IA", 0]);
  });
  it("imagem nova em EM_CRIACAO só anexa e avisa o designer", async () => {
    const d = await criarUsuario({ role: "DESIGNER" });
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    await mudarEtapa(jobId, "EM_CRIACAO", d);
    await abrirOuAnexar({ leadId: lead, origem: "LIA", imagens: [PNG] });
    expect((await job(jobId))!.stage).toBe("EM_CRIACAO");
    const n = await query<{ title: string }>("SELECT title FROM notifications WHERE user_id = $1", [d]);
    expect(n.map((x) => x.title)).toContain("Cliente mandou imagem nova");
  });
  it("dois abrirOuAnexar ao mesmo tempo geram um job só", async () => {
    const lead = await criarLead();
    const [a, b] = await Promise.all([
      abrirOuAnexar({ leadId: lead, origem: "LIA", imagens: [] }),
      abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] }),
    ]);
    expect(a.jobId).toBe(b.jobId);
    expect((await query("SELECT 1 FROM design_jobs")).length).toBe(1);
  });
  it("job novo guarda o modo anterior do lead no evento criado", async () => {
    const lead = await criarLead({ agentMode: "humano" });
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    const [e] = await query<{ dados: { modo_anterior: string } }>(
      "SELECT dados FROM design_events WHERE job_id = $1 AND tipo = 'criado'",
      [jobId]
    );
    expect(e.dados.modo_anterior).toBe("humano");
  });
});

describe("rodízio do designer", () => {
  it("dois designers alternam", async () => {
    const d1 = await criarUsuario({ role: "DESIGNER" });
    const d2 = await criarUsuario({ role: "DESIGNER" });
    const ids: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const lead = await criarLead();
      const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
      ids.push((await job(jobId))!.designer_id);
    }
    expect(ids).toEqual([d1, d2, d1]);
  });
  it("sem designer ativo, notifica os admins e o job fica sem designer", async () => {
    const admin = await criarUsuario({ role: "ADMIN" });
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    expect((await job(jobId))!.designer_id).toBeNull();
    expect((await query("SELECT 1 FROM notifications WHERE user_id = $1", [admin])).length).toBe(1);
    expect(await atribuirDesigner(jobId)).toBeNull();
  });
});
