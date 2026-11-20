import { z } from "zod";
import type { ConversationState } from "../agent/state.js";
import type { BrindeMeClient } from "../integrations/brindeme/client.js";
import { encaminharParaDesign } from "../integrations/crm/design.js";

export const encaminharDesignSchema = z.object({
  motivo: z.enum(["referencia_uniforme", "criacao_de_arte", "ajuste_de_arte"]).describe("Por que a arte vai para o designer"),
  observacao: z.string().max(500).optional().describe("O que o cliente pediu, em uma frase"),
});

export type EncaminharDesignInput = z.infer<typeof encaminharDesignSchema>;

export const MENSAGEM_ENCAMINHADO = "Recebi! Vou passar para nossa equipe de design, que vai te chamar por aqui.";

export async function encaminharDesignHandler(
  input: EncaminharDesignInput,
  state: ConversationState,
  _client: BrindeMeClient
): Promise<{ status: "encaminhado" | "erro"; mensagem: string; instrucao?: string }> {
  try {
    // O CRM anexa ao job aberto do lead: chamar de novo no mesmo turno não abre outro job
    await encaminharParaDesign({
      telefone: state.telefone,
      origem: "LIA",
      motivo: input.motivo,
      observacao: input.observacao,
      arquivos: state.arquivosRecebidos ?? [],
    });
    return { status: "encaminhado", mensagem: MENSAGEM_ENCAMINHADO };
  } catch {
    return {
      status: "erro",
      mensagem: "Não consegui passar a arte para a equipe de design agora.",
      instrucao: "Chame transferir_humano com motivo outro para a equipe seguir com o pedido de arte. Os arquivos continuam na conversa.",
    };
  }
}
