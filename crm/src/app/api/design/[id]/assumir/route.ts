import { NextResponse } from "next/server";
import { jsonError } from "@/lib/access";
import { assumir } from "@/lib/design";
import { erroDeDesign, guardaDoJob } from "@/lib/designHttp";

type Context = { params: Promise<{ id: string }> };

/** Job sem designer (nenhum ativo quando abriu): um designer pega para si. */
export async function POST(_request: Request, { params }: Context) {
  const { id } = await params;
  try {
    const g = await guardaDoJob(id);
    if (g.error) return g.error;
    if (g.user.role !== "DESIGNER") return jsonError("Só um designer assume o job.", 403);
    await assumir(id, g.user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return erroDeDesign(err, "assumir job");
  }
}
