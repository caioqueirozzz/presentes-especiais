import { NextResponse } from "next/server";
import { readJson } from "@/lib/access";
import { devolverAoAtendimento } from "@/lib/design";
import { erroDeDesign, guardaDoJob } from "@/lib/designHttp";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  const body = await readJson(request);
  const nota = typeof body.nota === "string" ? body.nota.trim().slice(0, 500) || undefined : undefined;
  try {
    const g = await guardaDoJob(id, { escrita: true });
    if (g.error) return g.error;
    await devolverAoAtendimento(id, g.user.id, nota);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return erroDeDesign(err, "devolver ao atendimento");
  }
}
