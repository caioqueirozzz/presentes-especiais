import { NextResponse } from "next/server";
import { jsonError, readJson, serverError } from "@/lib/access";
import { LIMITE_BYTES, MIME_AUDIO, armazem, detectarAudio } from "@/lib/arquivos";
import { one, query } from "@/lib/db";
import { integrationAuthorized } from "@/lib/integration";
import { phoneVariants } from "@/lib/orders";

const STATUS = ["OK", "FALHOU", "NAO_TRANSCRITO"] as const;

/** A ponte manda o áudio do cliente (e a transcrição, quando houve) depois da mensagem "🎤 Áudio" do mesmo id. */
export async function POST(request: Request) {
  if (!integrationAuthorized(request)) return jsonError("Não autorizado.", 401);
  const b = await readJson(request);
  const id = typeof b.id === "string" ? b.id.slice(0, 200) : "";
  const telefone = typeof b.telefone === "string" ? b.telefone.replace(/\D/g, "") : "";
  const status = STATUS.find((s) => s === b.status);
  const transcricao = b.transcricao ?? null;
  if (!id || telefone.length < 10 || !status || typeof b.base64 !== "string") {
    return jsonError("id, telefone, base64 e status são obrigatórios.", 400);
  }
  if (transcricao !== null && (typeof transcricao !== "string" || status !== "OK")) {
    return jsonError("transcricao só vem com status OK.", 400);
  }
  const bytes = Buffer.from(b.base64, "base64");
  if (bytes.length > LIMITE_BYTES) return jsonError("Áudio maior que 16 MB.", 413);
  // O tipo vem dos bytes, nunca do mime declarado
  const tipo = detectarAudio(bytes);
  if (!tipo) return jsonError("O arquivo não é áudio (ogg, mp3 ou m4a).", 422);
  try {
    const msg = await one<{ id: string; lead_id: string; media_key: string | null }>(
      `SELECT m.id, m.lead_id, m.media_key FROM messages m JOIN leads l ON l.id = m.lead_id
       WHERE l.phone = ANY($1) AND m.external_id = $2 AND m.source = 'WHATSAPP' LIMIT 1`,
      [phoneVariants(telefone), id]
    );
    if (!msg) return jsonError("Mensagem não encontrada.", 404);
    // A ponte repete o envio quando não sabe se chegou: não regrava
    if (msg.media_key) return NextResponse.json({ ok: true });
    const chave = `audios/${msg.lead_id}/${msg.id}.${tipo}`;
    await armazem().salvar(chave, bytes, MIME_AUDIO[tipo]);
    await query(
      "UPDATE messages SET media_key = $2, media_mime = $3, media_bytes = $4, transcription = $5, transcription_status = $6 WHERE id = $1",
      [msg.id, chave, MIME_AUDIO[tipo], bytes.length, typeof transcricao === "string" ? transcricao.slice(0, 4000) : null, status]
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err, "integração de mídias");
  }
}
