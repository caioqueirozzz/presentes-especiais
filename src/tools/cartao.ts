/**
 * Cartão de produto no formato do Dudu (ClickUp, 04/11): foto e legenda com nome, cores, preço unitário e
 * condição para mais unidades. Sem SKU e sem mínimo. O preço vem só da cotação exata do site.
 */
import { cotou, type Cotacao, type ResultadoCotacao } from "../catalogo/cotacao.js";
import type { ItemResposta } from "../contrato/esquemas.js";
import { formatarParaWhatsApp } from "../contrato/texto.js";
import { reais } from "./prepararOrcamento.js";

export interface Cartao {
  produto_id: string;
  imagem_url: string | null;
  legenda: string;
}

export interface DadosCartao {
  produto_id: string;
  nome: string;
  imagem_url: string | null;
  /** Sem quantidade, o cartão sai sem preço. */
  quantidade?: number;
  /** Cores conferidas no site (até 6), na ordem de exibição. */
  cotadas: Array<{ cor: string; cotacao: ResultadoCotacao }>;
  /** Cores disponíveis além das conferidas. */
  outras: string[];
}

export const SEM_PRECO = "Valor a confirmar com a equipe.";
export const CONDICAO_ESPECIAL = "Para quantidades maiores, a equipe faz uma condição especial.";
export const DEMAIS_CORES = "Demais cores: valor confirmo quando escolher.";

/** Frase única de "sem estoque": detalhar_produto e preparar_orcamento mandam o agente oferecer o humano. */
export const SEM_ESTOQUE_OFERECA_HUMANO =
  "Diga que não tem no estoque e ofereça o atendimento humano para confirmar (transferir_humano com motivo outro se ele aceitar).";

const porUnidade = (centavos: number) => `${reais(centavos / 100)}/un`;

export function montarCartao(d: DadosCartao): Cartao {
  const cores = [...d.cotadas.map((c) => c.cor), ...d.outras].filter(Boolean);
  const linhas = [`*${d.nome}*`];
  if (cores.length) linhas.push(`Cores: ${cores.join(", ")}`);
  if (d.quantidade !== undefined) {
    linhas.push(...linhasDePreco(d.cotadas, d.quantidade));
    if (d.outras.length) linhas.push(DEMAIS_CORES);
  }
  return { produto_id: d.produto_id, imagem_url: d.imagem_url, legenda: linhas.join("\n") };
}

function linhasDePreco(cotadas: DadosCartao["cotadas"], quantidade: number): string[] {
  const comPreco = cotadas.filter(
    (c): c is { cor: string; cotacao: Cotacao } => cotou(c.cotacao) && c.cotacao.centavos > 0
  );
  if (comPreco.length === 0) return [SEM_PRECO];

  const linhas: string[] = [];
  const porValor = new Map<number, string[]>();
  for (const c of comPreco) porValor.set(c.cotacao.centavos, [...(porValor.get(c.cotacao.centavos) ?? []), c.cor]);
  if (porValor.size === 1) {
    linhas.push(`${porUnidade(comPreco[0].cotacao.centavos)} para ${quantidade} un.`);
  } else {
    linhas.push(`Para ${quantidade} un.:`);
    for (const [centavos, nomes] of [...porValor].sort((a, b) => a[0] - b[0])) {
      linhas.push(`${nomes.join(", ")}: ${porUnidade(centavos)}`);
    }
  }
  const semPreco = cotadas.filter((c) => !comPreco.includes(c as { cor: string; cotacao: Cotacao })).map((c) => c.cor);
  if (semPreco.length) linhas.push(`${semPreco.join(", ")}: ${SEM_PRECO.toLowerCase()}`);
  linhas.push(condicao(comPreco));
  return linhas;
}

/** Decisão 7 da spec: só o próximo degrau mais barato; sem ele, a frase da condição especial. */
function condicao(comPreco: Array<{ cotacao: Cotacao }>): string {
  const degraus = comPreco.map((c) => c.cotacao.proximo).filter((p): p is NonNullable<Cotacao["proximo"]> => !!p);
  if (degraus.length === 0) return CONDICAO_ESPECIAL;
  const quantidade = Math.min(...degraus.map((p) => p.quantidade));
  const centavos = Math.min(...degraus.filter((p) => p.quantidade === quantidade).map((p) => p.centavos));
  return `A partir de ${quantidade} un.: ${porUnidade(centavos)}`;
}

const urlDeImagem = (u: string | null): u is string => !!u && /^https?:\/\//i.test(u) && URL.canParse(u);

/** Tópico ou linha com rótulo de campo do cartão: "- **Preço:** a confirmar", "• *Camisa*", "1. Camisa — R$ 42,41". */
const ROTULO_DO_CARTAO = /^\s*(?:(?:[-•·*]|\d+[.)])\s*)?\**\s*(?:cor(?:es)?|quantidade|pre[çc]o[^:\n]*|valor[^:\n]*|condi[çc][ãa]o[^:\n]*|a partir de[^:\n]*)\s*\**\s*:/i;
const TOPICO_DE_PRODUTO = /^\s*(?:[-•·]|\d+[.)])\s*(?:\*{1,2}[^*\n]+\*{1,2}\s*:?\s*$|.*R\$)/;
/** Linhas da legenda copiadas do histórico: título sozinho em negrito e o preço "R$ X/un". */
const LINHA_DE_LEGENDA = /^\s*\*{1,2}[^*\n]+\*{1,2}\s*$|\/un\b/i;
export const SO_PERGUNTA = "Qual dessas opções te agrada?";

/**
 * O modelo redigita o cartão mesmo proibido pelo prompt, e sem o preço inventa "a confirmar" (dogfooding de 09/11).
 * Vale em todo turno: sem chamar a busca, ele também copia o cartão que está no histórico.
 */
export function semRepetirCartoes(texto: string): string {
  // Resposta vazia é falha do modelo e tem tratamento próprio: não vira pergunta.
  if (!texto.trim()) return texto;
  const limpo = texto
    .split("\n")
    .filter((l) => !ROTULO_DO_CARTAO.test(l) && !TOPICO_DE_PRODUTO.test(l) && !LINHA_DE_LEGENDA.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return limpo || SO_PERGUNTA;
}

/** URL ruim derrubaria o parse da resposta na ponte e o turno inteiro: aí o cartão vai como texto. */
export function itensDosCartoes(cartoes: Cartao[]): ItemResposta[] {
  return cartoes.map((c) => (urlDeImagem(c.imagem_url) ? { imagem_url: c.imagem_url, legenda: c.legenda } : c.legenda));
}

/** Com cartão no turno o texto é fixo: o modelo vazava jargão ("cartões enviados") e listava o produto (dogfooding de 09/11). */
export function textoDosCartoes(quantos: number, saudacao?: string): string {
  const frase = quantos === 1 ? "Separei esta opção para você. Te agrada?" : "Separei estas opções para você. Qual te agrada?";
  return saudacao ? `${saudacao} ${frase}` : frase;
}

/** Com cartão: o texto do modelo num balão só, antes dos cartões (dogfooding de 09/11: 4 balões era carga demais). */
export function respostasDoTurno(cartoes: Cartao[], texto: string): ItemResposta[] {
  const partes = formatarParaWhatsApp(texto);
  if (cartoes.length === 0) return partes;
  return [...(partes.length ? [partes.join("\n\n")] : []), ...itensDosCartoes(cartoes)];
}
