import { NextResponse } from "next/server";
import { jsonError, readJson } from "@/lib/access";
import { enviarMockup } from "@/lib/design";
import { erroDeDesign, guardaDoJob } from "@/lib/designHttp";

type Context = { params: Promise<{ id: string }> };

/** Manda a versão do mockup ao cliente pelo WhatsApp. O designer assume a conversa. */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  const body = await readJson(request);
  const versao = Number(body.versao);
  const legenda = typeof body.legenda === "string" ? body.legenda.trim() : "";
  if (!Number.isInteger(versao) || versao < 1) return jsonError("Versão inválida.", 400);
  if (legenda.length > 1000) return jsonError("Legenda longa demais (máximo 1.000 caracteres).", 400);
  try {
    const g = await guardaDoJob(id, { escrita: true });
    if (g.error) return g.error;
    await enviarMockup(id, versao, legenda, g.user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return erroDeDesign(err, "enviar mockup");
  }
}
