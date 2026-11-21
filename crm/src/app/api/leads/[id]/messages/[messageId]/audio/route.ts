import { NextResponse } from "next/server";
import { getLeadForUser, isUuid, jsonError, requireUser, serverError } from "@/lib/access";
import { armazem } from "@/lib/arquivos";
import { one } from "@/lib/db";

type Context = { params: Promise<{ id: string; messageId: string }> };

/** O player do painel: redireciona para a URL temporária do áudio, só para quem vê o lead. */
export async function GET(request: Request, { params }: Context) {
  const guard = await requireUser({ allowDesigner: true });
  if (guard.error) return guard.error;
  const { id, messageId } = await params;
  try {
    // Lead fora do escopo responde 404, como o GET do lead: não revela que ele existe
    const lead = await getLeadForUser(id, guard.user);
    if (!lead || !isUuid(messageId)) return jsonError("Áudio não encontrado.", 404);
    const m = await one<{ media_key: string | null }>("SELECT media_key FROM messages WHERE id = $1 AND lead_id = $2", [messageId, id]);
    if (!m?.media_key) return jsonError("Áudio não encontrado.", 404);
    return NextResponse.redirect(new URL(await armazem().urlTemporaria(m.media_key), request.url), 302);
  } catch (err) {
    return serverError(err, "áudio do lead");
  }
}
