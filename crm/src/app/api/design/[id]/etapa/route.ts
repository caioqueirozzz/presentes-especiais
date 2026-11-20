import { NextResponse } from "next/server";
import { jsonError, readJson } from "@/lib/access";
import { ETAPAS_MANUAIS, mudarEtapa } from "@/lib/design";
import type { Etapa } from "@/lib/design";
import { erroDeDesign, guardaDoJob } from "@/lib/designHttp";

type Context = { params: Promise<{ id: string }> };

/** Começar, Reprocessar IA, Marcar ajustes e Cancelar. As outras etapas têm rota própria. */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  const body = await readJson(request);
  const para = body.para as Etapa;
  if (!ETAPAS_MANUAIS.includes(para)) return jsonError("Etapa inválida.", 400);
  try {
    const g = await guardaDoJob(id, { escrita: true });
    if (g.error) return g.error;
    await mudarEtapa(id, para, g.user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return erroDeDesign(err, "mudar etapa do job");
  }
}
