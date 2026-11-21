import { NextResponse } from "next/server";
import { jsonError } from "@/lib/access";
import { anexarMockup } from "@/lib/design";
import { arquivosDoForm, erroDeDesign, guardaDoJob } from "@/lib/designHttp";

type Context = { params: Promise<{ id: string }> };

/** Nova versão do mockup (multipart, campo "arquivo"). */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  try {
    const g = await guardaDoJob(id, { escrita: true });
    if (g.error) return g.error;
    const form = await request.formData().catch(() => null);
    if (!form) return jsonError("Envie o arquivo do mockup.", 400);
    const [arquivo] = await arquivosDoForm(form, "arquivo", 1);
    if (!arquivo) return jsonError("Envie o arquivo do mockup.", 400);
    return NextResponse.json(await anexarMockup(id, arquivo, g.user.id));
  } catch (err) {
    return erroDeDesign(err, "subir mockup");
  }
}
