import { z } from "zod";
import type { BrindeMeClient } from "../integrations/brindeme/client.js";
import { discutirProduto, type ConversationState } from "../agent/state.js";
import { FileProductIndexStore, type ProductIndexStore } from "../catalogo/indice.js";
import { FileOccasionTagStore, rotuloDaOcasiao, type OccasionTagStore } from "../catalogo/ocasioes.js";
import { recomendar, type Ajuste, type Recomendacao } from "../catalogo/recomendar.js";
import type { MotivoInelegivel } from "../catalogo/oferta.js";
import { cotou, guardarCotacoes, type Cotacao } from "../catalogo/cotacao.js";
import { montarCartao } from "./cartao.js";
import { arredondar } from "../integrations/brindeme/mappers.js";

export const buscarProdutosSchema = z.object({
  consulta: z
    .string()
    .describe("O que o cliente procura, em palavras-chave (produto, material, uso). Ex: 'caneca', 'algo para professores'"),
  quantidade: z.number().int().positive().optional().describe("Quantidade desejada. Sem ela o preço é só 'a partir de'"),
  preco_max_unitario: z.number().positive().optional().describe("Preço máximo por unidade, em reais"),
  orcamento_total: z
    .number()
    .positive()
    .optional()
    .describe("Valor total que o cliente quer gastar, em reais. Exige quantidade"),
  ocasiao: z.string().optional().describe("Ocasião do brinde (ex: natal, dia das mães, onboarding, corporativo)"),
});

export type BuscarProdutosInput = z.infer<typeof buscarProdutosSchema>;

/** Injetáveis para teste; em produção lêem o índice sincronizado e a tabela da loja. */
let indexPadrao: ProductIndexStore | null = null;
let tagsPadrao: OccasionTagStore | null = null;

export function setProductIndexStore(store: ProductIndexStore | null): void {
  indexPadrao = store;
}
export function setOccasionTagStore(store: OccasionTagStore | null): void {
  tagsPadrao = store;
}
function getIndex(): ProductIndexStore {
  if (!indexPadrao) indexPadrao = new FileProductIndexStore();
  return indexPadrao;
}
function getTags(): OccasionTagStore {
  if (!tagsPadrao) tagsPadrao = new FileOccasionTagStore();
  return tagsPadrao;
}

export const OBSERVACAO_PRECOS =
  "Preço do site por quantidade.";

const ROTULO_MOTIVO: Record<MotivoInelegivel, string> = {
  abaixo_do_minimo: "com pedido mínimo acima da quantidade pedida",
  estoque_insuficiente: "sem estoque suficiente em uma única cor para essa quantidade",
  sem_estoque: "sem estoque",
  sem_faixa_de_preco: "sem faixa de preço para essa quantidade",
  acima_do_orcamento: "acima do valor informado",
};

const INSTRUCAO_CARTOES =
  'Os cartões (foto, nome, cores, preço e condição para mais unidades) já vão ao cliente antes da sua mensagem. Não copie nem redigite o cartão (nome, cores, preço por unidade, condição, foto). total_se_o_cliente_perguntar: não cite; diga só se ele perguntar o total. Se o cliente pediu orçamento e já deu produto, cor, quantidade e os dados (PF ou PJ, nome e e-mail), chame preparar_orcamento agora com o subproduto_id dessa cor; faltando dado, peça, nunca invente. Senão, apresente em uma frase e pergunte qual agrada ou qual cor. Cartão com "Valor a confirmar com a equipe": se o cliente quiser fechar esse produto, transfira com transferir_humano.';

function explicar(eliminadosPor: Partial<Record<MotivoInelegivel, number>>): string {
  const partes = (Object.keys(ROTULO_MOTIVO) as MotivoInelegivel[])
    .filter((m) => (eliminadosPor[m] ?? 0) > 0)
    .map((m) => `${eliminadosPor[m]} ${ROTULO_MOTIVO[m]}`);
  return partes.length ? partes.join("; ") : "Nenhum produto atende aos critérios.";
}

function soEstoque(eliminadosPor: Partial<Record<MotivoInelegivel, number>>): boolean {
  const motivos = Object.keys(eliminadosPor);
  return motivos.length > 0 && motivos.every((m) => m === "sem_estoque" || m === "estoque_insuficiente");
}

function guardarNecessidade(state: ConversationState, input: BuscarProdutosInput): void {
  const n = state.necessidade;
  if (input.ocasiao) n.ocasiao = input.ocasiao;
  if (input.quantidade) n.quantidade = input.quantidade;
  if (input.preco_max_unitario) n.precoMaxUnitario = input.preco_max_unitario;
  if (input.orcamento_total) n.orcamentoTotal = input.orcamento_total;
}

function formatar(r: Recomendacao, input: BuscarProdutosInput, state: ConversationState): unknown {
  switch (r.tipo) {
    case "indice_vazio":
      return {
        erro: {
          falha_api: true as const,
          erro: "indice_indisponivel",
          tentar_novamente: false,
          transferir_imediato: true,
          alerta: true,
          detalhes: "O índice de catálogo está vazio. Rode: npm run sync:catalogo",
        },
      };

    case "falha_api":
      return { erro: r.erro };

    case "nenhum": {
      if (r.motivo === "sem_correspondencia") {
        return {
          resultado: "nenhum_produto_encontrado",
          motivo: "sem_correspondencia",
          razao: `Nenhum produto do catálogo corresponde a "${input.consulta}".`,
          ajustes_sugeridos: [] as Ajuste[],
          instrucao_ao_agente:
            "Diga que não encontrou e peça outras palavras ou o uso do brinde. Não sugira produto que não veio de uma ferramenta.",
        };
      }
      return {
        resultado: "nenhum_produto_encontrado",
        motivo: "regras_nao_fecham",
        razao: explicar(r.eliminadosPor),
        candidatos_relevantes: r.candidatosRelevantes,
        ajustes_sugeridos: r.ajustes,
        instrucao_ao_agente: soEstoque(r.eliminadosPor)
          ? "Diga que não tem no estoque para essa quantidade. Ofereça o ajuste de ajustes_sugeridos, se houver, e o atendimento humano para confirmar a disponibilidade (transferir_humano com motivo outro se ele aceitar). Não cite produto que não esteja em ajustes_sugeridos."
          : "Explique ao cliente, em uma frase, o que não fechou (quantidade, estoque ou valor). Se houver ajustes_sugeridos, ofereça o mais próximo e, se ele aceitar, chame buscar_produtos de novo com os novos números. Não cite produto que não esteja em ajustes_sugeridos.",
      };
    }

    case "encontrados": {
      for (const { produto } of r.itens) {
        for (const sub of produto.subprodutos) state.subprodutoParaProduto[sub.id] = produto.id;
        discutirProduto(state, produto.id, produto.nome);
      }
      // Com as cores: o turno seguinte ("aceito", "pode ser essa") precisa do subproduto_id, não do id do produto (#28).
      state.ultimasOpcoes = r.itens.map(({ produto, oferta }) => ({
        id: produto.id,
        nome: produto.nome,
        cores: oferta.cores.map((c) => ({ subproduto_id: c.subproduto_id, cor: c.cor })),
      }));
      const informada = r.quantidadeInformada;
      guardarCotacoes(state, r.itens.flatMap((i) => i.cotacoes));
      const cartoes = r.itens.map(({ produto: p, oferta, cotacoes }) =>
        montarCartao({
          produto_id: p.id,
          nome: p.nome,
          imagem_url: p.imagem_url,
          quantidade: informada ? oferta.quantidade : undefined,
          cotadas: oferta.cores.slice(0, cotacoes.length).map((c, i) => ({ cor: c.cor, cotacao: cotacoes[i] })),
          outras: oferta.cores.slice(cotacoes.length).map((c) => c.cor),
        })
      );
      return {
        resultado: "produtos_encontrados",
        total: r.itens.length,
        quantidade_considerada: r.quantidadeConsiderada,
        ...(input.ocasiao || r.ocasioes.length
          ? { ocasioes_consideradas: r.ocasioes.map(rotuloDaOcasiao) }
          : {}),
        ...(r.naoVerificados > 0 ? { produtos_nao_verificados: r.naoVerificados } : {}),
        observacao_precos: OBSERVACAO_PRECOS,
        ...(informada
          ? {}
          : {
              aviso:
                "O cliente não informou a quantidade, e o preço muda por faixa: não passe valor nenhum. Apresente as opções e pergunte a quantidade; depois chame buscar_produtos de novo com ela.",
            }),
        produtos: r.itens.map(({ produto: p, oferta, ocasiaoConfere, cotacoes }) => {
          const exatos = cotacoes.filter((c): c is Cotacao => cotou(c) && c.centavos > 0).map((c) => c.centavos);
          const menor = exatos.length ? Math.min(...exatos) : null;
          // Cores cotadas com preços diferentes: o total é o da mais barata, e o modelo precisa dizer qual é.
          const corDoTotal = exatos.some((e) => e !== menor)
            ? oferta.cores.find((_, i) => { const c = cotacoes[i]; return cotou(c) && c.centavos === menor; })?.cor
            : undefined;
          return {
            id: p.id,
            nome: p.nome,
            min_quantity: p.quantidade_minima,
            ...(informada
              ? {
                  preco_unitario_na_quantidade: menor === null ? null : menor / 100,
                  total_estimado: menor === null ? null : arredondar((menor * oferta.quantidade) / 100),
                  ...(corDoTotal ? { cor_do_total: corDoTotal } : {}),
                }
              : {}),
            // Produto sem variação de cor vem com color "" da API.
            cores_disponiveis: oferta.cores.map((c) => c.cor).filter(Boolean),
            // O id da cor vai junto: sem ele, o modelo mandava o id do produto ao preparar_orcamento.
            subprodutos: oferta.cores.map((c) => (c.cor ? { subproduto_id: c.subproduto_id, cor: c.cor } : { subproduto_id: c.subproduto_id })),
            ...(r.ocasioes.length ? { indicado_para_a_ocasiao: ocasiaoConfere } : {}),
          };
        }),
        cartoes,
        instrucao_ao_agente: INSTRUCAO_CARTOES,
      };
    }
  }
}

export async function buscarProdutosHandler(
  input: BuscarProdutosInput,
  state: ConversationState,
  client: BrindeMeClient
) {
  // Total sem quantidade não vira preço por unidade; é dado que falta, não busca vazia.
  if (input.orcamento_total !== undefined && input.quantidade === undefined) {
    return {
      resultado: "faltam_dados",
      faltando: ["quantidade"],
      mensagem:
        "Para usar o valor total como limite é preciso saber a quantidade. Pergunte a quantidade ao cliente antes de buscar.",
    };
  }

  guardarNecessidade(state, input);

  const recomendacao = await recomendar(
    {
      consulta: input.consulta,
      quantidade: input.quantidade,
      precoMaxUnitario: input.preco_max_unitario,
      orcamentoTotal: input.orcamento_total,
      ocasiao: input.ocasiao,
    },
    { index: getIndex(), tags: getTags(), client }
  );

  return formatar(recomendacao, input, state);
}
