import { z } from "zod";
import type { BrindeMeClient } from "../integrations/brindeme/client.js";
import { ApiError, translateApiError } from "../integrations/brindeme/errors.js";
import { discutirProduto, lembrarDetalhado, type ConversationState } from "../agent/state.js";
import { cotarAoVivo, cotou, guardarCotacoes, MAX_CORES_COTADAS, type ResultadoCotacao } from "../catalogo/cotacao.js";
import { proximoDegrau } from "../catalogo/faixasDeVenda.js";
import { ehSobDemanda } from "../catalogo/sobDemanda.js";
import { montarCartao, SEM_ESTOQUE_OFERECA_HUMANO, type Cartao } from "./cartao.js";

export const detalharProdutoSchema = z.object({
  produto_id: z.string().describe("ID do produto"),
  quantidade: z.number().int().positive().optional().describe("Quantidade desejada para calcular o preço"),
});

export type DetalharProdutoInput = z.infer<typeof detalharProdutoSchema>;

const AVISO_ESTOQUE = `Nenhuma cor tem estoque para essa quantidade. ${SEM_ESTOQUE_OFERECA_HUMANO} Nunca mude a quantidade sem ele pedir.`;

export async function detalharProdutoHandler(
  input: DetalharProdutoInput,
  state: ConversationState,
  client: BrindeMeClient
) {
  try {
    const p = await client.getProduct(input.produto_id);
    const activeSubs = p.subproducts.filter((s) => s.status);
    const sobDemanda = ehSobDemanda(p.id);
    const q = input.quantidade;

    // Guarda de onde veio cada subproduto: preparar_orcamento precisa disso
    // para resolver o item sem varrer o catálogo inteiro.
    for (const s of p.subproducts) state.subprodutoParaProduto[s.id] = p.id;
    discutirProduto(state, p.id, p.name);
    lembrarDetalhado(state, { id: p.id, nome: p.name, cores: activeSubs.map((s) => ({ subproduto_id: s.id, cor: s.color })) });

    const atende = (s: (typeof activeSubs)[number]) => sobDemanda || (q ? s.stock >= q : s.stock > 0);
    const disponiveis = activeSubs.filter(atende);
    const precos = new Map<string, number>();
    let cotadas: Array<{ cor: string; cotacao: ResultadoCotacao }> = [];
    // Abaixo do mínimo não há preço a dar: nada é cotado.
    if (q && q >= p.min_quantity) {
      const aCotar = disponiveis.slice(0, MAX_CORES_COTADAS);
      const cotacoes = await cotarAoVivo(client, aCotar.map((s) => ({ subprodutoId: s.id, quantidade: q, proximoDegrau: proximoDegrau(s.prices, q) })));
      guardarCotacoes(state, cotacoes);
      for (const c of cotacoes) if (cotou(c) && c.centavos > 0) precos.set(c.subproduto_id, c.centavos / 100);
      cotadas = aCotar.map((s, i) => ({ cor: s.color, cotacao: cotacoes[i] }));
    }

    const subprodutos = activeSubs.map((s) => ({
      subproduto_id: s.id,
      cor: s.color,
      estoque: s.stock,
      disponivel: sobDemanda || s.stock > 0,
      preco_para_quantidade: precos.get(s.id) ?? null,
      // O modelo errou a conta (112 ≥ 100) e transferiu: a comparação sai pronta.
      atende_quantidade: q ? atende(s) : null,
    }));

    const cartoes: Cartao[] = [
      montarCartao({
        produto_id: p.id,
        nome: p.name,
        imagem_url: p.images[0]?.url ?? null,
        quantidade: cotadas.length ? q : undefined,
        cotadas,
        outras: disponiveis.slice(cotadas.length).map((s) => s.color),
      }),
    ];

    return {
      id: p.id,
      nome: p.name,
      descricao: p.description,
      min_quantity: p.min_quantity,
      subprodutos_ativos: subprodutos,
      cores_que_atendem_quantidade: q ? subprodutos.filter((s) => s.atende_quantidade).map((s) => s.cor) : null,
      ...(q && disponiveis.length === 0 ? { aviso_estoque: AVISO_ESTOQUE } : {}),
      preco_para_quantidade_a_partir_de: precos.size ? Math.min(...precos.values()) : null,
      ...(!q
        ? { aviso: "Sem a quantidade não há preço: pergunte quantas unidades." }
        : q < p.min_quantity
          ? { aviso: `Abaixo do pedido mínimo de ${p.min_quantity} un.: não há preço para essa quantidade. Diga o mínimo ao cliente.` }
          : {}),
      imagens: p.images.map((i) => i.url),
      personalizacoes: p.customizations.map((c) => `${c.type}: ${c.description}`),
      cartoes,
    };
  } catch (err) {
    // Id inventado pelo modelo não é a API fora do ar: não conta para a transferência por falha.
    if (err instanceof ApiError && err.status === 404) {
      return {
        resultado: "produto_nao_encontrado" as const,
        instrucao_ao_agente: "Esse produto_id não existe. Ache o produto com buscar_produtos e use o id que ele devolver; nunca invente id.",
      };
    }
    return { erro: translateApiError(err) };
  }
}
