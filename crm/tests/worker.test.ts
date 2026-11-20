import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { one, query } from "@/lib/db";
import { abrirOuAnexar, mudarEtapa } from "@/lib/design";
import { pegarProximo, processarJob } from "@/lib/designIa/worker";
import { criarLead, criarUsuario, limparBanco } from "./banco";

const FICHA = {
  peca: "camisa polo",
  gola: "polo",
  manga: "curta",
  tecido_provavel: null,
  elementos: [{ tipo: "logo", conteudo: null, posicao: "peito esquerdo", bbox: [10, 20, 30, 40] }],
  observacoes: null,
  briefing: "Polo azul com logo no peito.",
};

type Job = {
  stage: string;
  ia_status: string;
  ia_tentativas: number;
  ia_proxima_tentativa_em: Date | null;
  ficha: Record<string, unknown>;
  briefing: string | null;
  designer_id: string | null;
};
const ler = (id: string) => one<Job>("SELECT * FROM design_jobs WHERE id = $1", [id]);
const eventos = (id: string) => query<{ tipo: string; dados: Record<string, unknown> }>("SELECT tipo, dados FROM design_events WHERE job_id = $1 ORDER BY created_at, id", [id]);
// Medida pelo relógio do banco: o do Docker pode divergir alguns segundos do relógio do PC
const esperaNoBanco = async (id: string) =>
  Number((await one<{ s: string }>("SELECT EXTRACT(EPOCH FROM ia_proxima_tentativa_em - NOW()) AS s FROM design_jobs WHERE id = $1", [id]))!.s);
const adiantar = (id: string) => query("UPDATE design_jobs SET ia_proxima_tentativa_em = NOW() - interval '1 second' WHERE id = $1", [id]);

let png: Buffer;
function ok(antes?: () => Promise<unknown>): typeof fetch {
  return (async () => {
    await antes?.();
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(FICHA) } }], usage: { prompt_tokens: 900, completion_tokens: 120 } }));
  }) as unknown as typeof fetch;
}
const status = (s: number) => (async () => new Response("erro", { status: s })) as unknown as typeof fetch;

async function jobComImagem(): Promise<{ jobId: string; leadId: string }> {
  await criarUsuario({ role: "DESIGNER" });
  const leadId = await criarLead();
  await query("INSERT INTO messages (lead_id, external_id, author, body) VALUES ($1, 'm1', 'CLIENTE', 'quero 50 polos')", [leadId]);
  const { jobId } = await abrirOuAnexar({ leadId, origem: "VENDEDOR", imagens: [{ bytes: png, nome: "ref.png" }] });
  return { jobId, leadId };
}

beforeAll(async () => {
  process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "arq-"));
  png = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#0A2A66" } }).png().toBuffer();
});
const chave = process.env.OPENAI_API_KEY;
beforeEach(async () => {
  await limparBanco();
  process.env.OPENAI_API_KEY = "sk-teste";
});
afterEach(() => {
  process.env.OPENAI_API_KEY = chave;
});

describe("worker do kit de partida", () => {
  it("sucesso grava ficha, paleta, briefing, evento com tokens e vai para a fila com designer", async () => {
    const { jobId } = await jobComImagem();
    const pego = await pegarProximo();
    expect(pego).toMatchObject({ id: jobId, tentativa: 1 });
    expect(await processarJob(pego!, { fetchFn: ok() })).toBe("ok");
    const j = await ler(jobId);
    expect(j).toMatchObject({ stage: "NA_FILA", ia_status: "OK", briefing: FICHA.briefing });
    expect(j!.designer_id).toBeTruthy();
    expect(j!.ficha).toMatchObject({ peca: "camisa polo", imagem_analisada: { largura: 200, altura: 100 } });
    expect((j!.ficha.paleta as Array<{ hex: string }>)[0].hex).toBe("#0A2A66");
    const ev = (await eventos(jobId)).find((e) => e.tipo === "ia_ok");
    expect(ev?.dados).toMatchObject({ input_tokens: 900, output_tokens: 120, modelo: expect.any(String) });
  });

  it("3 falhas seguidas: espera 30 s, depois 120 s, e na 3ª vai para a fila com IA falhou", async () => {
    const { jobId } = await jobComImagem();
    expect(await processarJob((await pegarProximo())!, { fetchFn: status(500) })).toBe("nova_tentativa");
    let j = await ler(jobId);
    expect(j!.stage).toBe("PROCESSANDO_IA");
    const espera1 = await esperaNoBanco(jobId);
    expect(espera1).toBeGreaterThan(25);
    expect(espera1).toBeLessThan(35);
    expect(await pegarProximo()).toBeNull();

    await adiantar(jobId);
    const segundo = await pegarProximo();
    expect(segundo!.tentativa).toBe(2);
    expect(await processarJob(segundo!, { fetchFn: status(500) })).toBe("nova_tentativa");
    j = await ler(jobId);
    const espera2 = await esperaNoBanco(jobId);
    expect(espera2).toBeGreaterThan(115);
    expect(espera2).toBeLessThan(125);

    await adiantar(jobId);
    expect(await processarJob((await pegarProximo())!, { fetchFn: status(500) })).toBe("falhou");
    j = await ler(jobId);
    expect(j).toMatchObject({ stage: "NA_FILA", ia_status: "FALHOU" });
    const ev = (await eventos(jobId)).find((e) => e.tipo === "ia_falhou");
    expect(String(ev?.dados.motivo)).toContain("500");
  });

  it("JSON inválido conta como falha", async () => {
    await jobComImagem();
    const fetchFn = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "{quebrado" } }] }))) as unknown as typeof fetch;
    expect(await processarJob((await pegarProximo())!, { fetchFn })).toBe("nova_tentativa");
  });

  it("401 falha na primeira", async () => {
    const { jobId } = await jobComImagem();
    expect(await processarJob((await pegarProximo())!, { fetchFn: status(401) })).toBe("falhou");
    expect(await ler(jobId)).toMatchObject({ stage: "NA_FILA", ia_status: "FALHOU", ia_tentativas: 1 });
  });

  it("imagem nova durante o processamento descarta o resultado", async () => {
    const { jobId, leadId } = await jobComImagem();
    const pego = (await pegarProximo())!;
    // Imagem diferente de verdade: a mesma (mesmo sha256) não conta como nova
    const outra = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#FFCC00" } }).png().toBuffer();
    const fetchFn = ok(() => abrirOuAnexar({ leadId, origem: "VENDEDOR", imagens: [{ bytes: outra, nome: "outra.png" }] }));
    expect(await processarJob(pego, { fetchFn })).toBe("descartado");
    expect(await ler(jobId)).toMatchObject({ stage: "PROCESSANDO_IA", ia_tentativas: 0, briefing: null });
  });

  it("job cancelado durante o processamento descarta o resultado", async () => {
    const { jobId } = await jobComImagem();
    const pego = (await pegarProximo())!;
    expect(await processarJob(pego, { fetchFn: ok(() => mudarEtapa(jobId, "CANCELADO", null)) })).toBe("descartado");
    const j = await ler(jobId);
    expect(j!.stage).toBe("CANCELADO");
    expect(j!.ficha).toEqual({});
  });

  it("a conversa do briefing começa depois do último job fechado do lead", async () => {
    await criarUsuario({ role: "DESIGNER" });
    const leadId = await criarLead();
    await query("INSERT INTO messages (lead_id, external_id, author, body, sent_at) VALUES ($1, 'a', 'CLIENTE', 'pedido antigo de canecas', NOW() - interval '2 hours')", [leadId]);
    const antigo = await abrirOuAnexar({ leadId, origem: "VENDEDOR", imagens: [] });
    await mudarEtapa(antigo.jobId, "CANCELADO", null);
    await query("UPDATE design_jobs SET updated_at = NOW() - interval '1 hour' WHERE id = $1", [antigo.jobId]);
    await query("INSERT INTO messages (lead_id, external_id, author, body, sent_at) VALUES ($1, 'b', 'CLIENTE', 'agora quero 30 bonés', NOW() - interval '10 minutes')", [leadId]);
    await abrirOuAnexar({ leadId, origem: "VENDEDOR", imagens: [{ bytes: png, nome: "bone.png" }] });

    let texto = "";
    const fetchFn = (async (_url: string, init: RequestInit) => {
      texto = JSON.parse(String(init.body)).messages[1].content[0].text;
      return ok()("");
    }) as unknown as typeof fetch;
    expect(await processarJob((await pegarProximo())!, { fetchFn })).toBe("ok");
    expect(texto).toContain("agora quero 30 bonés");
    expect(texto).not.toContain("canecas");
  });

  it("job só com PDF vai para a fila sem imagem, sem chamar a OpenAI", async () => {
    await criarUsuario({ role: "DESIGNER" });
    const leadId = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId, origem: "VENDEDOR", imagens: [{ bytes: Buffer.from("%PDF-1.4"), nome: "logo.pdf" }] });
    await mudarEtapa(jobId, "PROCESSANDO_IA", null); // reprocessamento manual
    let chamou = false;
    const fetchFn = (async () => {
      chamou = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(await processarJob((await pegarProximo())!, { fetchFn })).toBe("ok");
    expect(await ler(jobId)).toMatchObject({ stage: "NA_FILA", ia_status: "SEM_IMAGEM" });
    expect(chamou).toBe(false);
  });
});
