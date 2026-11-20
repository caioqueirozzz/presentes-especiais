import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { one, query } from "@/lib/db";
import { armazem } from "@/lib/arquivos";
import { POST } from "@/app/api/integracao/midias/route";
import { criarLead, limparBanco } from "./banco";

const SEGREDO = "segredo-da-integracao-123";
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]).toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
const TEL = "5583999990000";

beforeAll(() => {
  process.env.CRM_INTEGRATION_SECRET = SEGREDO;
  process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "arq-"));
});

const pedir = (corpo: object, segredo = SEGREDO) =>
  POST(new Request("http://x/api/integracao/midias", { method: "POST", headers: { "content-type": "application/json", "x-crm-secret": segredo }, body: JSON.stringify(corpo) }));

async function mensagemDeAudio(): Promise<{ leadId: string; msgId: string }> {
  const leadId = await criarLead({ phone: TEL });
  const m = await one<{ id: string }>(
    "INSERT INTO messages (lead_id, external_id, author, body, sent_at, source, kind) VALUES ($1, 'wa-1', 'CLIENTE', '🎤 Áudio', NOW(), 'WHATSAPP', 'audio') RETURNING id",
    [leadId]
  );
  return { leadId, msgId: m!.id };
}

const corpo = (extra: object = {}) => ({ id: "wa-1", telefone: TEL, mime: "audio/ogg", base64: OGG, transcricao: "quero canecas", status: "OK", ...extra });

describe("POST /api/integracao/midias", () => {
  beforeEach(limparBanco);

  it("401 sem o segredo", async () => {
    expect((await pedir(corpo(), "errado-errado-errado")).status).toBe(401);
  });

  it("404 sem a mensagem", async () => {
    await criarLead({ phone: TEL });
    expect((await pedir(corpo())).status).toBe(404);
  });

  it("422 com bytes que não são áudio", async () => {
    await mensagemDeAudio();
    expect((await pedir(corpo({ base64: PNG }))).status).toBe(422);
  });

  it("transcricao com status diferente de OK é recusada", async () => {
    await mensagemDeAudio();
    expect((await pedir(corpo({ status: "FALHOU" }))).status).toBe(400);
  });

  it("200: grava no armazém e nas cinco colunas; o segundo envio não regrava", async () => {
    const { leadId, msgId } = await mensagemDeAudio();
    expect((await pedir(corpo())).status).toBe(200);
    const m = await one<Record<string, unknown>>("SELECT media_key, media_mime, media_bytes, transcription, transcription_status FROM messages WHERE id = $1", [msgId]);
    expect(m).toEqual({ media_key: `audios/${leadId}/${msgId}.ogg`, media_mime: "audio/ogg", media_bytes: 64, transcription: "quero canecas", transcription_status: "OK" });
    expect((await armazem().ler(m!.media_key as string)).subarray(0, 4).toString()).toBe("OggS");

    expect((await pedir(corpo({ transcricao: "outra coisa" }))).status).toBe(200);
    const [{ t }] = await query<{ t: string }>("SELECT transcription AS t FROM messages WHERE id = $1", [msgId]);
    expect(t).toBe("quero canecas");
  });

  it("NAO_TRANSCRITO grava sem texto", async () => {
    const { msgId } = await mensagemDeAudio();
    expect((await pedir(corpo({ transcricao: null, status: "NAO_TRANSCRITO" }))).status).toBe(200);
    const [r] = await query<{ s: string; t: string | null }>("SELECT transcription_status AS s, transcription AS t FROM messages WHERE id = $1", [msgId]);
    expect(r).toEqual({ s: "NAO_TRANSCRITO", t: null });
  });
});
