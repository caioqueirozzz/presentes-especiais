import { z } from "zod";
import type { BrindeMeClient } from "../integrations/brindeme/client.js";
import { discutirProduto, type ConversationState } from "../agent/state.js";
import type { IndiceCatalogo, ProductIndexStore } from "../catalogo/indice.js";
import { FileOccasionTagStore, rotuloDaOcasiao, type OccasionTagStore } from "../catalogo/ocasioes.js";
import { recomendar, type Ajuste, type Recomendacao } from "../catalogo/recomendar.js";
import type { MotivoInelegivel } from "../catalogo/oferta.js";
import { cotou, guardarCotacoes, type Cotacao } from "../catalogo/cotacao.js";
import { montarCartao } from "./cartao.js";
import { arredondar } from "../integrations/brindeme/mappers.js";
import { MotorSemantico } from "../catalogo/semantica.js";

export const buscarProdutosSchema = z.object({
  consulta: z
    .string()
    .describe("O que o cliente procura, em palavras-chave (produto, material, uso). Ex: 'caneca', 'algo para professores'"),
  tipo_produto: z
    .string()
    .optional()
    .describe(
      "O tipo de produto que o cliente nomeou, no singular (camiseta, caneca, caneta). Omita se ele não nomeou um tipo (ex.: 'algo para professores')."
    ),
  quantidade: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Quantidade desejada. Sem ela o preço é só 'a partir de'. Omita se o cliente não disse um número. Nunca use 1 por padrão."
    ),
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
/** O índice em uso: carregado uma vez e trocado só por `recarregarIndice`, nunca lido a cada pergunta. */
let indiceCarregado: IndiceCatalogo | null = null;
let tagsPadrao: OccasionTagStore | null = null;
let semanticaPadrao: MotorSemantico | null = null;

export function setProductIndexStore(store: ProductIndexStore | null): void {
  indexPadrao = store;
  indiceCarregado = null;
}
/** Relê o catálogo do store e passa a buscar nele. A partida e o sync chamam; a busca não. */
export async function recarregarIndice(): Promise<IndiceCatalogo> {
  if (!indexPadrao) throw new Error("store do catálogo não ligado: chame ligarStores(banco) na partida");
  indiceCarregado = await indexPadrao.carregar();
  return indiceCarregado;
}
export function setOccasionTagStore(store: OccasionTagStore | null): void {
  tagsPadrao = store;
}
/** `null` desliga a busca semântica e devolve o BM25 (usado pelos testes e pelo modo de reserva). */
export function setMotorSemantico(motor: MotorSemantico | null): void {
  semanticaPadrao = motor;
}
async function getIndice(): Promise<IndiceCatalogo> {
  if (indiceCarregado) return indiceCarregado;
  return recarregarIndice();
}
function getTags(): OccasionTagStore {
  if (!tagsPadrao) tagsPadrao = new FileOccasionTagStore();
  return tagsPadrao;
}

/** Sem motor ligado (`ligarSemantica`), a busca segue lexical (BM25). */
function getSemantica(): MotorSemantico | undefined {
  return semanticaPadrao ?? undefined;
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

/**
 * Põe os produtos de `ajustes_sugeridos` no estado da conversa, do mesmo jeito
 * que os produtos com cartão. Sem isso o cliente dizia "quero 200 dessa" sobre
 * um produto que só apareceu como ajuste, e o modelo, sem achar o id, buscava
 * de novo e trazia outra coisa (dogfooding de 09/11, §3.2).
 */
function registrarAjustes(state: ConversationState, ajustes: Ajuste[]): void {
  if (ajustes.length === 0) return;
  const vistos = new Set<string>();
  const opcoes: ConversationState["ultimasOpcoes"] = [];
  for (const a of ajustes) {
    if (vistos.has(a.produto_id)) continue;
    vistos.add(a.produto_id);
    discutirProduto(state, a.produto_id, a.nome);
    if (a.subproduto_id) state.subprodutoParaProduto[a.subproduto_id] = a.produto_id;
    opcoes.push({
      id: a.produto_id,
      nome: a.nome,
      cores: a.subproduto_id ? [{ subproduto_id: a.subproduto_id, cor: a.cor ?? "" }] : [],
    });
  }
  state.ultimasOpcoes = opcoes;
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

    // O cliente nomeou um tipo e o catálogo não tem nenhum produto dele. Sem cartões
    // e sem vizinho de outro tipo: mostrar um foi o erro que o dogfooding pegou, e sem
    // cartão a frase fixa do turno não entra (runTurn), então o modelo pode explicar.
    case "nenhum_do_tipo":
      return {
        resultado: "nenhum_do_tipo",
        tipo_pedido: r.tipoPedido,
        razao: `O catálogo não tem nenhum produto do tipo "${r.tipoPedido}".`,
        ajustes_sugeridos: [] as Ajuste[],
        instrucao_ao_agente:
          "Diga em UMA frase que a loja não trabalha com esse tipo de produto e ofereça falar com um atendente (transferir_humano com motivo outro, se ele aceitar). Não sugira produto de outro tipo, não invente substituto e não chame buscar_produtos de novo com as mesmas palavras.",
      };

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
      // O produto do ajuste entra no estado como se tivesse sido mostrado: o "quero 200
      // dessa" do dogfooding só achava produto em ultimasOpcoes, e o id do ajuste não
      // estava lá — o modelo buscava de novo e trazia outro produto (#dogfooding 3.2).
      registrarAjustes(state, r.ajustes);
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
          quantidade: oferta.quantidade,
          no_minimo: !informada,
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
                "O cliente não informou a quantidade. Os cartões já saíram com o preço do PEDIDO MÍNIMO de cada produto, que muda por faixa: não cite nem recalcule valor nenhum. Apresente as opções e pergunte quantas unidades ele quer; depois chame buscar_produtos de novo com a quantidade.",
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
              : {
                  // Sem total: o cliente ainda não disse quantas unidades quer, e um total
                  // no mínimo pareceria o valor do pedido dele.
                  preco_unitario_no_pedido_minimo: menor === null ? null : menor / 100,
                }),
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
      tipoProduto: input.tipo_produto,
      quantidade: input.quantidade,
      precoMaxUnitario: input.preco_max_unitario,
      orcamentoTotal: input.orcamento_total,
      ocasiao: input.ocasiao,
    },
    { indice: await getIndice(), tags: getTags(), client, semantica: getSemantica() }
  );

  return formatar(recomendacao, input, state);
}
