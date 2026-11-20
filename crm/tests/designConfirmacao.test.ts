import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ponte = vi.hoisted(() => ({ chamadas: [] as Array<{ path: string; body: unknown }>, falhar: new Set<string>() }));
vi.mock("@/lib/whatsapp", () => ({
  callPonte: async (path: string, body: unknown) => {
    ponte.chamadas.push({ path, body });
    return ponte.falhar.has(path) ? { ok: false, status: 503, error: "fora", offline: true } : { ok: true, data: { id: "msg-1" } };
  },
}));

import { one, query } from "@/lib/db";
import { ingestLiveMessage } from "@/lib/ingest";
import {
  DesignError,
  abrirOuAnexar,
  anexarMockup,
  ehAprovacao,
  enviarMockup,
  mudarEtapa,
  pedirConfirmacao,
  receberRespostaDoCliente,
} from "@/lib/design";
import { criarLead, criarUsuario, limparBanco } from "./banco";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const etapa = async (id: string) => (await one<{ stage: string }>("SELECT stage FROM design_jobs WHERE id = $1", [id]))!.stage;
const titulos = async (userId: string) => (await query<{ title: string }>("SELECT title FROM notifications WHERE user_id = $1", [userId])).map((n) => n.title);

beforeAll(() => {
  process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "arq-"));
});
beforeEach(async () => {
  await limparBanco();
  ponte.chamadas = [];
  ponte.falhar.clear();
});

describe("ehAprovacao", () => {
  it.each(["APROVO", " aprovo! ", "Aprovó", "aprovo."])("%s aprova", (t) => expect(ehAprovacao(t)).toBe(true));
  it.each(["aprovo sim", "ok", "pode ser", "👍", "", "não aprovo"])("%s não aprova", (t) => expect(ehAprovacao(t)).toBe(false));
});

async function jobEmCriacao(agentMode: "ia" | "humano" = "ia") {
  const d = await criarUsuario({ role: "DESIGNER" });
  const vendedor = await criarUsuario({ role: "COLABORADOR" });
  const lead = await criarLead({ assignedTo: vendedor, agentMode });
  const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", requestedBy: vendedor, imagens: [] });
  await mudarEtapa(jobId, "EM_CRIACAO", d);
  return { d, vendedor, lead, jobId };
}

async function jobAguardando(agentMode: "ia" | "humano" = "ia") {
  const j = await jobEmCriacao(agentMode);
  const { versao } = await anexarMockup(j.jobId, { bytes: PNG, nome: "v1.png" }, j.d);
  await enviarMockup(j.jobId, versao, "Segue a arte", j.d);
  return j;
}

describe("mockup e envio", () => {
  it("o envio vai pela /enviar-midia, liga a conversa com o designer e pausa a Lia", async () => {
    const { lead, jobId } = await jobAguardando();
    expect(await etapa(jobId)).toBe("AGUARDANDO_CLIENTE");
    const envio = ponte.chamadas.find((c) => c.path === "/enviar-midia")!.body as { url: string; legenda: string };
    expect(envio.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(envio.url).toContain("/api/design/arquivo?chave=");
    expect(envio.legenda).toBe("Segue a arte");
    const j = await one<{ conversa_com_designer: boolean }>("SELECT conversa_com_designer FROM design_jobs WHERE id = $1", [jobId]);
    expect(j!.conversa_com_designer).toBe(true);
    expect((await one<{ agent_mode: string }>("SELECT agent_mode FROM leads WHERE id = $1", [lead]))!.agent_mode).toBe("humano");
  });
  it("versões do mockup sobem", async () => {
    const { d, jobId } = await jobEmCriacao();
    expect((await anexarMockup(jobId, { bytes: PNG, nome: "a.png" }, d)).versao).toBe(1);
    expect((await anexarMockup(jobId, { bytes: PNG, nome: "b.png" }, d)).versao).toBe(2);
  });
  it("mockup que não é imagem é recusado", async () => {
    const { d, jobId } = await jobEmCriacao();
    await expect(anexarMockup(jobId, { bytes: Buffer.from("%PDF-1.4"), nome: "a.pdf" }, d)).rejects.toBeInstanceOf(DesignError);
  });
  it("ponte fora no envio não muda a etapa", async () => {
    const { d, jobId } = await jobEmCriacao();
    const { versao } = await anexarMockup(jobId, { bytes: PNG, nome: "v1.png" }, d);
    ponte.falhar.add("/enviar-midia");
    await expect(enviarMockup(jobId, versao, "x", d)).rejects.toBeInstanceOf(DesignError);
    expect(await etapa(jobId)).toBe("EM_CRIACAO");
  });
});

describe("dupla confirmação", () => {
  it("sem confirmação pendente, nada acontece", async () => {
    const { lead, jobId } = await jobAguardando();
    expect(await receberRespostaDoCliente(lead, "APROVO")).toBe("sem_confirmacao_pendente");
    expect(await etapa(jobId)).toBe("AGUARDANDO_CLIENTE");
  });
  it("'ok' não aprova, registra a prova e avisa o designer; 'APROVO' aprova", async () => {
    const { d, lead, jobId } = await jobAguardando();
    await pedirConfirmacao(jobId, d);
    const legenda = (ponte.chamadas.filter((c) => c.path === "/enviar-midia").at(-1)!.body as { legenda: string }).legenda;
    expect(legenda).toContain("versão 1");
    expect(legenda).toContain("APROVO");

    expect(await receberRespostaDoCliente(lead, "ok")).toBe("nao_confirmou");
    expect(await etapa(jobId)).toBe("AGUARDANDO_CLIENTE");
    expect((await titulos(d)).some((t) => t.includes("não confirmou"))).toBe(true);

    expect(await receberRespostaDoCliente(lead, "Aprovo!")).toBe("aprovado");
    expect(await etapa(jobId)).toBe("APROVADO");
    const provas = await query<{ dados: { texto: string; aprovou: boolean } }>(
      "SELECT dados FROM design_events WHERE job_id = $1 AND tipo = 'resposta_confirmacao' ORDER BY created_at",
      [jobId]
    );
    expect(provas.map((p) => [p.dados.texto, p.dados.aprovou])).toEqual([
      ["ok", false],
      ["Aprovo!", true],
    ]);
    expect((await query("SELECT 1 FROM design_assets WHERE job_id = $1 AND tipo = 'ARTE_FINAL'", [jobId])).length).toBe(1);
    expect(ponte.chamadas.some((c) => c.path === "/devolver")).toBe(true);
    expect((await one<{ agent_mode: string }>("SELECT agent_mode FROM leads WHERE id = $1", [lead]))!.agent_mode).toBe("ia");
  });
  it("aprovação com pedido move o pedido para PRODUCAO com evento", async () => {
    const { d, lead, jobId } = await jobAguardando();
    const [o] = await query<{ id: string }>(
      "INSERT INTO orders (lead_id, phone, title, stage, code) VALUES ($1, '5511900000099', 'x', 'ARTE', 'P-T1') RETURNING id",
      [lead]
    );
    await query("UPDATE design_jobs SET order_id = $2 WHERE id = $1", [jobId, o.id]);
    await pedirConfirmacao(jobId, d);
    await receberRespostaDoCliente(lead, "APROVO");
    expect((await one<{ stage: string }>("SELECT stage FROM orders WHERE id = $1", [o.id]))!.stage).toBe("PRODUCAO");
    expect((await query("SELECT 1 FROM order_events WHERE order_id = $1 AND to_stage = 'PRODUCAO'", [o.id])).length).toBe(1);
  });
  it("aprovação não faz regredir pedido que já passou da produção", async () => {
    const { d, lead, jobId } = await jobAguardando();
    const [o] = await query<{ id: string }>(
      "INSERT INTO orders (lead_id, phone, title, stage, code) VALUES ($1, '5511900000099', 'x', 'EXPEDICAO', 'P-T2') RETURNING id",
      [lead]
    );
    await query("UPDATE design_jobs SET order_id = $2 WHERE id = $1", [jobId, o.id]);
    await pedirConfirmacao(jobId, d);
    await receberRespostaDoCliente(lead, "APROVO");
    expect(await etapa(jobId)).toBe("APROVADO");
    expect((await one<{ stage: string }>("SELECT stage FROM orders WHERE id = $1", [o.id]))!.stage).toBe("EXPEDICAO");
  });
  it("APROVO enviado antes do pedido de confirmação não aprova, mesmo chegando depois", async () => {
    const { d, lead, jobId } = await jobAguardando();
    const antes = new Date(Date.now() - 60_000).toISOString();
    await pedirConfirmacao(jobId, d);
    const phone = (await one<{ phone: string }>("SELECT phone FROM leads WHERE id = $1", [lead]))!.phone;
    await ingestLiveMessage({ id: "w-velho", telefone: phone, autor: "CLIENTE", texto: "aprovo", timestamp: antes });
    expect(await etapa(jobId)).toBe("AGUARDANDO_CLIENTE");
  });
  it("aprovação sem pedido avisa o vendedor", async () => {
    const { d, vendedor, lead, jobId } = await jobAguardando();
    await pedirConfirmacao(jobId, d);
    await receberRespostaDoCliente(lead, "APROVO");
    expect(await titulos(vendedor)).toContain("Arte aprovada, falta o pedido");
  });
  it("ajustes apagam a confirmação pendente", async () => {
    const { d, lead, jobId } = await jobAguardando();
    await pedirConfirmacao(jobId, d);
    await mudarEtapa(jobId, "AJUSTES", d);
    expect(await receberRespostaDoCliente(lead, "APROVO")).toBe("sem_confirmacao_pendente");
  });
  it("ponte fora na devolução não desfaz a aprovação e avisa o designer", async () => {
    const { d, lead, jobId } = await jobAguardando();
    await pedirConfirmacao(jobId, d);
    ponte.falhar.add("/devolver");
    expect(await receberRespostaDoCliente(lead, "APROVO")).toBe("aprovado");
    expect(await etapa(jobId)).toBe("APROVADO");
    expect((await titulos(d)).some((t) => /devolver/i.test(t))).toBe(true);
  });
  it("lead que já era humano antes do job não chama /devolver; avisa o vendedor", async () => {
    const { d, vendedor, lead, jobId } = await jobAguardando("humano");
    await pedirConfirmacao(jobId, d);
    await receberRespostaDoCliente(lead, "APROVO");
    expect(ponte.chamadas.some((c) => c.path === "/devolver")).toBe(false);
    expect(await titulos(vendedor)).toContain("A conversa voltou para você");
  });
  it("cancelar com a conversa no designer devolve a conversa", async () => {
    const { d, jobId } = await jobAguardando();
    await mudarEtapa(jobId, "CANCELADO", d);
    expect(await etapa(jobId)).toBe("CANCELADO");
    expect(ponte.chamadas.some((c) => c.path === "/devolver")).toBe(true);
  });
});

describe("ingestLiveMessage com job de design", () => {
  it("cliente responde: o aviso vai ao designer e o APROVO é conferido", async () => {
    const { d, vendedor, lead, jobId } = await jobAguardando();
    await pedirConfirmacao(jobId, d);
    const phone = (await one<{ phone: string }>("SELECT phone FROM leads WHERE id = $1", [lead]))!.phone;
    await query("DELETE FROM notifications");
    await ingestLiveMessage({ id: "w-1", telefone: phone, autor: "CLIENTE", texto: "vou ver", timestamp: new Date().toISOString() });
    expect(await titulos(d)).toContain("Cliente respondeu");
    expect(await titulos(vendedor)).not.toContain("Cliente respondeu");
    await ingestLiveMessage({ id: "w-2", telefone: phone, autor: "CLIENTE", texto: "APROVO", timestamp: new Date().toISOString() });
    expect(await etapa(jobId)).toBe("APROVADO");
  });

  it("a devolução leva o id do APROVO, para a ponte não entregar essa mensagem à Lia", async () => {
    const { d, lead, jobId } = await jobAguardando();
    await pedirConfirmacao(jobId, d);
    const phone = (await one<{ phone: string }>("SELECT phone FROM leads WHERE id = $1", [lead]))!.phone;
    ponte.chamadas = [];
    await ingestLiveMessage({ id: "w-aprovo", telefone: phone, autor: "CLIENTE", texto: "APROVO", timestamp: new Date().toISOString() });
    expect(ponte.chamadas).toContainEqual({ path: "/devolver", body: { telefone: phone, consumidas: ["w-aprovo"] } });
  });
});
