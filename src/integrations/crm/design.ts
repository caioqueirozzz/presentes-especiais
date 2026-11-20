import { readFile } from "fs/promises";
import { config } from "../../config.js";
import type { ArquivoRecebido } from "../../agent/state.js";

/**
 * Abre (ou anexa a) um job de design no CRM com os arquivos que o cliente mandou pelo WhatsApp.
 * Usado pela ponte (botão "Enviar para design" do CRM) e pela ferramenta encaminhar_design da Lia.
 * O CRM é dono do job: chamar de novo anexa ao job aberto, não abre outro.
 */
export interface PedidoDesign {
  telefone: string;
  origem: "LIA" | "VENDEDOR";
  motivo?: string;
  observacao?: string;
  prioridade?: "normal" | "alta";
  requestedBy?: string;
  arquivos: ArquivoRecebido[];
}

export type Encaminhar = (p: PedidoDesign) => Promise<{ jobId: string; imagens: number }>;

const PRAZO_MS = 30_000;

async function noCrm(p: PedidoDesign): Promise<{ jobId: string; imagens: number }> {
  if (!config.crm.url || config.crm.segredo.length < 16) throw new Error("CRM não configurado.");
  const form = new FormData();
  form.set("telefone", p.telefone);
  form.set("origem", p.origem);
  for (const [campo, valor] of [
    ["motivo", p.motivo],
    ["observacao", p.observacao],
    ["prioridade", p.prioridade],
    ["requested_by", p.requestedBy],
  ] as const) {
    if (valor) form.set(campo, valor);
  }
  let imagens = 0;
  for (const a of p.arquivos) {
    // Arquivo apagado do disco (limpeza, outra máquina): segue com os outros
    const bytes = await readFile(a.caminho).catch(() => null);
    if (!bytes) continue;
    form.append("imagem", new Blob([bytes], { type: a.mime }), a.nome);
    imagens++;
  }
  const res = await fetch(`${config.crm.url}/api/integracao/design`, {
    method: "POST",
    headers: { "x-crm-secret": config.crm.segredo },
    body: form,
    signal: AbortSignal.timeout(PRAZO_MS),
  });
  if (!res.ok) throw new Error(`CRM respondeu ${res.status}`);
  const corpo = (await res.json()) as { jobId?: unknown };
  if (typeof corpo.jobId !== "string") throw new Error("CRM respondeu sem jobId");
  return { jobId: corpo.jobId, imagens };
}

let impl: Encaminhar = noCrm;

export const encaminharParaDesign: Encaminhar = (p) => impl(p);

/** Testes e evals trocam o envio por um falso; null volta ao CRM de verdade. */
export function setEncaminharParaDesign(fn: Encaminhar | null): void {
  impl = fn ?? noCrm;
}
