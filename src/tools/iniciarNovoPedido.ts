import { z } from "zod";
import type { ConversationState } from "../agent/state.js";
import type { BrindeMeClient } from "../integrations/brindeme/client.js";

export const iniciarNovoPedidoSchema = z.object({
  o_que_procura: z
    .string()
    .max(200)
    .optional()
    .describe("O que o cliente disse que quer agora, em poucas palavras (ex.: 'chaveiros para o fim de ano')."),
});

export type IniciarNovoPedidoInput = z.infer<typeof iniciarNovoPedidoSchema>;

/** Nada apurado ainda desde o último recomeço: chamar de novo não abre outro ciclo. */
function cicloAindaVazio(state: ConversationState): boolean {
  const n = state.necessidade;
  return (
    Boolean(state.novoPedidoIniciadoEm) &&
    !state.fichaPedido &&
    !state.orcamentoEnviado &&
    state.produtosDiscutidos.length === 0 &&
    !n.quantidade &&
    !n.ocasiao
  );
}

/**
 * Cliente que já comprou (ou que já tem um pedido em produção) quer fazer um pedido NOVO.
 * Guarda o resumo do que foi apurado antes, limpa o que é do pedido (necessidade, produtos, estimativa,
 * artes) e mantém quem é o cliente (nome, PF/PJ, e-mail, empresa, memória). O CRM vê o ciclo subir e
 * devolve o lead para prospecção e qualificação, sem misturar com os pedidos que já existem.
 */
export async function iniciarNovoPedidoHandler(input: IniciarNovoPedidoInput, state: ConversationState, _client: BrindeMeClient) {
  if (cicloAindaVazio(state)) {
    return { status: "ja_em_novo_pedido", instrucao_ao_agente: "O pedido novo já está aberto: siga a triagem." };
  }

  const agora = new Date().toISOString();
  const anterior = state.orcamentoEnviado ?? state.fichaPedido?.resumo;
  const temAlgo =
    anterior || state.produtosDiscutidos.length > 0 || state.necessidade.quantidade || state.necessidade.ocasiao;
  if (temAlgo) {
    state.pedidosAnteriores = [
      ...(state.pedidosAnteriores ?? []),
      {
        encerrado_em: agora,
        ...(state.necessidade.ocasiao ? { ocasiao: state.necessidade.ocasiao } : {}),
        ...(state.necessidade.quantidade ? { quantidade: state.necessidade.quantidade } : {}),
        produtos: anterior?.itens.map((i) => i.nome_produto) ?? state.produtosDiscutidos.slice(0, 5),
        ...(anterior ? { total_estimado: anterior.total_estimado } : {}),
      },
    ].slice(-5);
  }

  state.necessidade = {};
  state.produtosDiscutidos = [];
  state.ultimasOpcoes = undefined;
  state.produtosDetalhados = undefined;
  state.fichaPedido = undefined;
  state.orcamentoEnviado = undefined;
  state.artes = [];
  state.ciclo = (state.ciclo ?? 0) + 1;
  state.novoPedidoIniciadoEm = agora;

  return {
    status: "novo_pedido_iniciado",
    ...(input.o_que_procura ? { o_que_procura: input.o_que_procura } : {}),
    instrucao_ao_agente:
      "Este é um pedido NOVO e separado dos pedidos que o cliente já tem (cite esses só pelo código, se ele perguntar). Faça a triagem normal: o que procura, quantidade, ocasião, prazo. Não pergunte de novo o que já está em cliente (nome, PF/PJ, e-mail, empresa). Se já souber o que ele quer, chame buscar_produtos agora.",
  };
}
