import { NextResponse } from "next/server";
import { pedirConfirmacao } from "@/lib/design";
import { erroDeDesign, guardaDoJob } from "@/lib/designHttp";

type Context = { params: Promise<{ id: string }> };

/** "Cliente aprovou": reenvia o mockup pedindo o APROVO. Só a resposta do cliente aprova. */
export async function POST(_request: Request, { params }: Context) {
  const { id } = await params;
  try {
    const g = await guardaDoJob(id, { escrita: true });
    if (g.error) return g.error;
    await pedirConfirmacao(id, g.user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return erroDeDesign(err, "pedir confirmação");
  }
}
