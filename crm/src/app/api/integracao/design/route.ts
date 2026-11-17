import { NextResponse } from "next/server";
import { isUuid, jsonError } from "@/lib/access";
import { one } from "@/lib/db";
import { abrirOuAnexar } from "@/lib/design";
import { arquivosDoForm, erroDeDesign } from "@/lib/designHttp";
import { integrationAuthorized } from "@/lib/integration";
import { phoneVariants } from "@/lib/orders";

/** A ponte (botão do CRM ou ferramenta da Lia) abre ou anexa ao job de design, com as imagens da conversa. */
export async function POST(request: Request) {
  if (!integrationAuthorized(request)) return jsonError("Não autorizado.", 401);
  const form = await request.formData().catch(() => null);
  if (!form) return jsonError("Corpo inválido.", 400);
  const telefone = String(form.get("telefone") ?? "").replace(/\D/g, "");
  const origem = form.get("origem");
  if (telefone.length < 10 || (origem !== "LIA" && origem !== "VENDEDOR")) return jsonError("telefone e origem são obrigatórios.", 400);
  const texto = (campo: string, max: number) => {
    const v = form.get(campo);
    return typeof v === "string" ? v.trim().slice(0, max) || undefined : undefined;
  };
  const requestedBy = texto("requested_by", 64);
  try {
    // A ponte só encaminha conversa que já chegou ao CRM
    const lead = await one<{ id: string }>("SELECT id FROM leads WHERE phone = ANY($1) ORDER BY created_at LIMIT 1", [phoneVariants(telefone)]);
    if (!lead) return jsonError("Lead não encontrado.", 404);
    const r = await abrirOuAnexar({
      leadId: lead.id,
      origem,
      requestedBy: requestedBy && isUuid(requestedBy) ? requestedBy : null,
      motivo: texto("motivo", 60),
      observacao: texto("observacao", 500),
      prioridade: texto("prioridade", 10) === "alta" ? "alta" : "normal",
      imagens: await arquivosDoForm(form, "imagem"),
    });
    return NextResponse.json(r);
  } catch (err) {
    return erroDeDesign(err, "integração de design");
  }
}
