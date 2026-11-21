import type { Etapa } from "@/lib/design";

/* Réguas do quadro de design, sem imports de servidor. Espelho das transições de crm/src/lib/design.ts. */

export const COLUNAS: Array<{ key: string; label: string; etapas: Etapa[]; border: string }> = [
  { key: "recebido", label: "Recebido", etapas: ["RECEBIDO", "PROCESSANDO_IA"], border: "border-primary/40" },
  { key: "fila", label: "Na fila", etapas: ["NA_FILA"], border: "border-sky-400" },
  { key: "criacao", label: "Em criação", etapas: ["EM_CRIACAO"], border: "border-amber-400" },
  { key: "cliente", label: "Aguardando cliente", etapas: ["AGUARDANDO_CLIENTE"], border: "border-violet-400" },
  { key: "ajustes", label: "Ajustes", etapas: ["AJUSTES"], border: "border-orange-400" },
  { key: "aprovado", label: "Aprovado", etapas: ["APROVADO"], border: "border-green-500" },
];

export const ROTULO_ETAPA: Record<Etapa, string> = {
  RECEBIDO: "Recebido",
  PROCESSANDO_IA: "Analisando...",
  NA_FILA: "Na fila",
  EM_CRIACAO: "Em criação",
  AGUARDANDO_CLIENTE: "Aguardando cliente",
  AJUSTES: "Ajustes",
  APROVADO: "Aprovado",
  CANCELADO: "Cancelado",
};

export function seloIa(stage: Etapa, iaStatus: string): { texto: string; classe: string } | null {
  if (stage === "PROCESSANDO_IA") return { texto: "Analisando...", classe: "bg-sky-50 text-sky-800" };
  if (iaStatus === "OK") return { texto: "IA ok", classe: "bg-green-50 text-green-800" };
  if (iaStatus === "FALHOU") return { texto: "IA falhou", classe: "bg-red-50 text-red-700" };
  if (iaStatus === "SEM_IMAGEM") return { texto: "Sem imagem", classe: "bg-on-surface/[0.05] text-on-surface-variant" };
  return null;
}

export type Acao = "assumir" | "comecar" | "reprocessar" | "enviar_mockup" | "ajustes" | "cliente_aprovou" | "devolver" | "cancelar";

const POR_ETAPA: Record<Etapa, Acao[]> = {
  RECEBIDO: ["cancelar"],
  PROCESSANDO_IA: ["cancelar"],
  NA_FILA: ["comecar", "reprocessar", "cancelar"],
  EM_CRIACAO: ["enviar_mockup", "devolver", "cancelar"],
  AGUARDANDO_CLIENTE: ["ajustes", "cliente_aprovou", "devolver", "cancelar"],
  AJUSTES: ["enviar_mockup", "devolver", "cancelar"],
  APROVADO: [],
  CANCELADO: [],
};

/** Botões que a tela mostra. O servidor confere de novo cada um. */
export function botoesDaEtapa(
  stage: Etapa,
  quem: { souDesigner: boolean; isAdmin: boolean; semDesigner: boolean; conversaComDesigner?: boolean }
): Acao[] {
  if (quem.semDesigner && quem.souDesigner) return POR_ETAPA[stage].length ? ["assumir"] : [];
  if (!quem.isAdmin && !(quem.souDesigner && !quem.semDesigner)) return [];
  // Job fechado com a conversa ainda no designer: a devolução à Lia falhou (ponte fora) e precisa ser refeita
  if (!POR_ETAPA[stage].length && quem.conversaComDesigner) return ["devolver"];
  return POR_ETAPA[stage];
}
