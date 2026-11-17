import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import {
  DesignError,
  abrirOuAnexar,
  assumir,
  detalharJob,
  gatilhoArte,
  jobAbertoDoLead,
  jobDoUsuario,
  ligarConversaComDesigner,
  listarJobs,
} from "@/lib/design";
import { criarLead, criarUsuario, limparBanco } from "./banco";

const PNG = { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), nome: "ref.png" };
const SVG = { bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), nome: "logo.svg" };

beforeAll(() => {
  process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "arq-"));
});
beforeEach(limparBanco);

async function doisDesigners() {
  const d1 = await criarUsuario({ role: "DESIGNER" });
  const d2 = await criarUsuario({ role: "DESIGNER" });
  const admin = await criarUsuario({ role: "ADMIN" });
  const j1 = (await abrirOuAnexar({ leadId: await criarLead(), origem: "VENDEDOR", imagens: [] })).jobId; // vai ao d1
  const j2 = (await abrirOuAnexar({ leadId: await criarLead(), origem: "VENDEDOR", imagens: [] })).jobId; // vai ao d2
  return { d1, d2, admin, j1, j2 };
}

describe("listarJobs", () => {
  it("designer vê só os dele; admin vê todos; aprovado antigo some", async () => {
    const { d1, admin, j1, j2 } = await doisDesigners();
    expect((await listarJobs({ id: d1, role: "DESIGNER" })).map((j) => j.id)).toEqual([j1]);
    expect((await listarJobs({ id: admin, role: "ADMIN" })).map((j) => j.id).sort()).toEqual([j1, j2].sort());
    await query("UPDATE design_jobs SET stage = 'APROVADO', updated_at = NOW() - interval '15 days' WHERE id = $1", [j2]);
    expect((await listarJobs({ id: admin, role: "ADMIN" })).map((j) => j.id)).toEqual([j1]);
  });
  it("o card nunca traz o telefone", async () => {
    const { admin } = await doisDesigners();
    const [card] = await listarJobs({ id: admin, role: "ADMIN" });
    expect(JSON.stringify(card)).not.toMatch(/55119/);
  });
});

describe("jobDoUsuario e assumir", () => {
  it("designer não acha job de outro; admin acha qualquer", async () => {
    const { d1, admin, j2 } = await doisDesigners();
    expect(await jobDoUsuario(j2, { id: d1, role: "DESIGNER" })).toBeNull();
    expect((await jobDoUsuario(j2, { id: admin, role: "ADMIN" }))?.id).toBe(j2);
    expect(await jobDoUsuario("nao-e-uuid", { id: admin, role: "ADMIN" })).toBeNull();
  });
  it("job sem designer: designer acha e pode assumir; com designer, assumir falha", async () => {
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] }); // sem designer ativo
    const d = await criarUsuario({ role: "DESIGNER" });
    expect((await jobDoUsuario(jobId, { id: d, role: "DESIGNER" }))?.id).toBe(jobId);
    await assumir(jobId, d);
    expect((await jobDoUsuario(jobId, { id: d, role: "DESIGNER" }))?.designer_id).toBe(d);
    const outro = await criarUsuario({ role: "DESIGNER" });
    await expect(assumir(jobId, outro)).rejects.toBeInstanceOf(DesignError);
  });
});

describe("gatilhoArte e ligarConversaComDesigner", () => {
  it("lead ou pedido em ARTE abre job de origem PEDIDO; sem lead não faz nada", async () => {
    const lead = await criarLead();
    const ator = await criarUsuario({ role: "ADMIN" });
    await gatilhoArte({ leadId: lead, atorId: ator });
    await gatilhoArte({ leadId: lead, atorId: ator }); // já aberto: nada muda
    await gatilhoArte({ leadId: null, atorId: ator });
    const jobs = await query<{ origem: string }>("SELECT origem FROM design_jobs");
    expect(jobs).toEqual([{ origem: "PEDIDO" }]);
  });
  it("liga a conversa só no job aberto do próprio designer", async () => {
    const d1 = await criarUsuario({ role: "DESIGNER" });
    const d2 = await criarUsuario({ role: "DESIGNER" });
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] }); // d1
    await ligarConversaComDesigner(lead, d2);
    const flag = async () => (await query<{ c: boolean }>("SELECT conversa_com_designer AS c FROM design_jobs WHERE id = $1", [jobId]))[0].c;
    expect(await flag()).toBe(false);
    await ligarConversaComDesigner(lead, d1);
    expect(await flag()).toBe(true);
  });
});

describe("detalharJob", () => {
  it("PNG sai com url assinada; SVG só para download", async () => {
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [PNG, SVG] });
    const det = await detalharJob(jobId);
    const png = det.assets.find((a) => a.mime === "image/png")!;
    const svg = det.assets.find((a) => a.mime === "image/svg+xml")!;
    expect(png.url).toContain("/api/design/arquivo?");
    expect(png.download).toBe(false);
    expect(svg.download).toBe(true);
    expect(det.eventos.length).toBeGreaterThan(0);
    expect(det.job.id).toBe(jobId);
  });
  it("jobAbertoDoLead acha o aberto e ignora o cancelado", async () => {
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    expect((await jobAbertoDoLead(lead))?.id).toBe(jobId);
    await query("UPDATE design_jobs SET stage = 'CANCELADO' WHERE id = $1", [jobId]);
    expect(await jobAbertoDoLead(lead)).toBeNull();
  });
});
