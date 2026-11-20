import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { one, query } from "@/lib/db";
import { signSession } from "@/lib/auth/token";
import { armazem } from "@/lib/arquivos";
import { GET as ouvir } from "@/app/api/leads/[id]/messages/[messageId]/audio/route";
import { GET as arquivo } from "@/app/api/design/arquivo/route";
import { criarLead, criarUsuario, limparBanco } from "./banco";

let token = "";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: token }) }) }));

beforeAll(() => {
  process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "arq-"));
});

async function entrarComo(role: "ADMIN" | "COLABORADOR"): Promise<string> {
  const id = await criarUsuario({ role });
  await query("UPDATE users SET must_change_password = false WHERE id = $1", [id]);
  const { v } = (await one<{ v: number }>("SELECT session_version AS v FROM users WHERE id = $1", [id]))!;
  token = await signSession({ sub: id, role, v });
  return id;
}

const AUDIO = Buffer.concat([Buffer.from("OggS"), Buffer.from(Array.from({ length: 96 }, (_, i) => i))]);

async function audioDoLead(assignedTo: string | null, comMidia = true): Promise<{ leadId: string; msgId: string; chave: string }> {
  const leadId = await criarLead({ assignedTo });
  const m = await one<{ id: string }>(
    "INSERT INTO messages (lead_id, external_id, author, body, sent_at, source, kind) VALUES ($1, 'wa-a', 'CLIENTE', '🎤 Áudio', NOW(), 'WHATSAPP', 'audio') RETURNING id",
    [leadId]
  );
  const chave = `audios/${leadId}/${m!.id}.ogg`;
  if (comMidia) {
    await armazem().salvar(chave, AUDIO, "audio/ogg");
    await query("UPDATE messages SET media_key = $2, media_mime = 'audio/ogg', transcription_status = 'NAO_TRANSCRITO' WHERE id = $1", [m!.id, chave]);
  }
  return { leadId, msgId: m!.id, chave };
}

const pedir = (leadId: string, msgId: string) =>
  ouvir(new Request(`http://crm.local/api/leads/${leadId}/messages/${msgId}/audio`), { params: Promise.resolve({ id: leadId, messageId: msgId }) });

describe("áudio do lead", () => {
  beforeEach(limparBanco);

  it("302 para a URL temporária, para quem vê o lead", async () => {
    const eu = await entrarComo("COLABORADOR");
    const { leadId, msgId } = await audioDoLead(eu);
    const r = await pedir(leadId, msgId);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/api/design/arquivo?chave=audios%2F");
  });

  it("404 para vendedor fora do lead", async () => {
    await entrarComo("COLABORADOR");
    const outro = await criarUsuario({ role: "COLABORADOR" });
    const { leadId, msgId } = await audioDoLead(outro);
    expect((await pedir(leadId, msgId)).status).toBe(404);
  });

  it("404 para mensagem sem áudio guardado", async () => {
    await entrarComo("ADMIN");
    const { leadId, msgId } = await audioDoLead(null, false);
    expect((await pedir(leadId, msgId)).status).toBe(404);
  });

  describe("rota de disco", () => {
    async function urlAssinada(): Promise<string> {
      await entrarComo("ADMIN");
      const { chave } = await audioDoLead(null);
      return `http://crm.local${await armazem().urlTemporaria(chave)}`;
    }

    it("serve o áudio inteiro com o tipo certo e Accept-Ranges", async () => {
      const r = await arquivo(new Request(await urlAssinada()));
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("audio/ogg");
      expect(r.headers.get("accept-ranges")).toBe("bytes");
      expect(Buffer.from(await r.arrayBuffer())).toEqual(AUDIO);
    });

    it("Range: 206 com o pedaço e Content-Range", async () => {
      const r = await arquivo(new Request(await urlAssinada(), { headers: { range: "bytes=10-19" } }));
      expect(r.status).toBe(206);
      expect(r.headers.get("content-range")).toBe(`bytes 10-19/${AUDIO.length}`);
      expect(Buffer.from(await r.arrayBuffer())).toEqual(AUDIO.subarray(10, 20));
    });

    it("Range aberto e sufixo", async () => {
      const url = await urlAssinada();
      expect(Buffer.from(await (await arquivo(new Request(url, { headers: { range: "bytes=90-" } }))).arrayBuffer())).toEqual(AUDIO.subarray(90));
      expect(Buffer.from(await (await arquivo(new Request(url, { headers: { range: "bytes=-5" } }))).arrayBuffer())).toEqual(AUDIO.subarray(AUDIO.length - 5));
    });

    it("Range além do fim: 416; Range malformado: o arquivo inteiro", async () => {
      const url = await urlAssinada();
      const fora = await arquivo(new Request(url, { headers: { range: "bytes=500-600" } }));
      expect(fora.status).toBe(416);
      expect(fora.headers.get("content-range")).toBe(`bytes */${AUDIO.length}`);
      expect((await arquivo(new Request(url, { headers: { range: "pedaço=1-2" } }))).status).toBe(200);
    });
  });
});
