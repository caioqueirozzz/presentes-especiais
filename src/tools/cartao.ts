/**
 * Cartão de produto no formato do Dudu (ClickUp, 04/11): foto e legenda com nome, cores, preço unitário e
 * condição para mais unidades. Sem SKU e sem mínimo. O preço vem só da cotação exata do site.
 */
import { cotou, type Cotacao, type ResultadoCotacao } from "../catalogo/cotacao.js";
import type { ItemResposta } from "../contrato/esquemas.js";
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

/** URL ruim derrubaria o parse da resposta na ponte e o turno inteiro: aí o cartão vai como texto. */
export function itensDosCartoes(cartoes: Cartao[]): ItemResposta[] {
  return cartoes.map((c) => (urlDeImagem(c.imagem_url) ? { imagem_url: c.imagem_url, legenda: c.legenda } : c.legenda));
}
