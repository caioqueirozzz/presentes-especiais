import { NextResponse } from "next/server";
import { getLeadForUser, jsonError, requireUser } from "@/lib/access";
import { abrirOuAnexar } from "@/lib/design";
import { arquivosDoForm, erroDeDesign } from "@/lib/designHttp";
import { callPonte } from "@/lib/whatsapp";

type Context = { params: Promise<{ id: string }> };

/**
 * Botão "Enviar para design" do vendedor. Com arquivo no corpo, é upload manual; sem arquivo,
 * a ponte manda os arquivos que o cliente enviou na conversa. Ponte fora: o job abre sem eles.
 */
export async function POST(request: Request, { params }: Context) {
  const guard = await requireUser();
  if (guard.error) return guard.error;
  const { id } = await params;
  try {
    const lead = await getLeadForUser(id, guard.user);
    if (!lead) return jsonError("Lead não encontrado.", 404);
    const multipart = (request.headers.get("content-type") ?? "").startsWith("multipart/form-data");
    const form = multipart ? await request.formData().catch(() => null) : null;
    const imagens = form ? await arquivosDoForm(form, "imagem") : [];
    if (imagens.length) {
      return NextResponse.json(await abrirOuAnexar({ leadId: lead.id, origem: "VENDEDOR", requestedBy: guard.user.id, imagens }));
    }
    const ponte = await callPonte<{ jobId: string; imagens: number }>("/encaminhar-design", { telefone: lead.phone, requested_by: guard.user.id }, 40_000);
    if (ponte.ok) return NextResponse.json(ponte.data);
    const r = await abrirOuAnexar({ leadId: lead.id, origem: "VENDEDOR", requestedBy: guard.user.id, imagens: [] });
    return NextResponse.json({ ...r, aviso: "A ponte do WhatsApp não respondeu: o job abriu sem as imagens da conversa." });
  } catch (err) {
    return erroDeDesign(err, "enviar para design");
  }
}
