import { config } from "../../config.js";

/**
 * Pedidos que o cliente já tem no quadro de Pedidos do CRM, para a Lia saber, antes de responder,
 * se fala com quem já comprou (e com qual pedido em andamento). Só o necessário para o prompt:
 * nada da observação interna da equipe.
 */
export interface PedidoDoCliente {
  codigo: string;
  descricao: string;
  etapa_atual: string;
  entregue: boolean;
  /** ISO: separa o pedido novo em qualificação (começou depois) dos pedidos que já existiam. */
  criado_em: string;
}

/** O CRM fora do ar não pode atrasar a resposta: passou disso, a Lia segue sem o histórico. */
const PRAZO_MS = 3_000;
/** Pedido muda de etapa poucas vezes por dia; dentro de uma conversa, um minuto basta. */
const VALIDADE_MS = 60_000;

type Buscar = (telefone: string) => Promise<PedidoDoCliente[]>;

async function buscarNoCrm(telefone: string): Promise<PedidoDoCliente[]> {
  // contexto=1: leitura de fundo, não é o cliente perguntando pelo pedido (não dispara o aviso de atraso)
  const res = await fetch(`${config.crm.url}/api/integracao/pedidos?telefone=${encodeURIComponent(telefone)}&contexto=1`, {
    headers: { "x-crm-secret": config.crm.segredo },
    signal: AbortSignal.timeout(PRAZO_MS),
  });
  if (!res.ok) throw new Error(`CRM respondeu ${res.status}`);
  const corpo = (await res.json()) as { pedidos?: Array<Partial<PedidoDoCliente>> };
  return (corpo.pedidos ?? [])
    .filter((p): p is PedidoDoCliente => typeof p.codigo === "string" && typeof p.criado_em === "string")
    .map((p) => ({
      codigo: p.codigo,
      descricao: String(p.descricao ?? ""),
      etapa_atual: String(p.etapa_atual ?? ""),
      entregue: p.entregue === true,
      criado_em: p.criado_em,
    }));
}

let buscar: Buscar = buscarNoCrm;
const cache = new Map<string, { em: number; pedidos: PedidoDoCliente[] | null }>();

/** Injetável para teste (null volta ao CRM de verdade). Limpa o cache. */
export function setBuscarHistoricoCliente(fn: Buscar | null): void {
  buscar = fn ?? buscarNoCrm;
  cache.clear();
}

/**
 * Pedidos do cliente, ou null quando não dá para saber (CRM não configurado ou fora do ar).
 * null é diferente de []: [] é "nunca comprou", null é "não sei".
 */
export async function historicoDoCliente(telefone: string): Promise<PedidoDoCliente[] | null> {
  if (!config.crm.url || config.crm.segredo.length < 16) return null;
  const guardado = cache.get(telefone);
  if (guardado && Date.now() - guardado.em < VALIDADE_MS) return guardado.pedidos;
  let pedidos: PedidoDoCliente[] | null;
  try {
    pedidos = await buscar(telefone);
  } catch {
    pedidos = null; // guardado também: com o CRM fora, não espera 3 s a cada mensagem
  }
  cache.set(telefone, { em: Date.now(), pedidos });
  if (cache.size > 2_000) cache.delete(cache.keys().next().value!);
  return pedidos;
}

/** O que vai para o estado do prompt. */
export function clienteDaLoja(pedidos: PedidoDoCliente[] | null, novoPedidoIniciadoEm: string | undefined) {
  if (pedidos === null) return { historico_de_pedidos: "indisponivel" as const };
  const ultimo = pedidos.reduce((max, p) => (p.criado_em > max ? p.criado_em : max), "");
  return {
    ja_cliente: pedidos.length > 0,
    pedidos_em_andamento: pedidos.filter((p) => !p.entregue).map(({ codigo, descricao, etapa_atual }) => ({ codigo, descricao, etapa_atual })),
    pedidos_entregues: pedidos
      .filter((p) => p.entregue)
      .slice(0, 3)
      .map(({ codigo, descricao }) => ({ codigo, descricao })),
    // O pedido novo já começou nesta conversa e ainda não virou pedido no quadro
    novo_pedido_em_qualificacao: Boolean(novoPedidoIniciadoEm && (!ultimo || novoPedidoIniciadoEm > ultimo)),
  };
}
