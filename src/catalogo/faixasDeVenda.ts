/**
 * Faixas de venda a partir dos limites das faixas de custo (spec da Fase 0, 5.2). O valor do custo não entra
 * em conta nenhuma: só os limites dizem onde o preço do site pode mudar.
 */
import type { PriceRange } from "../integrations/brindeme/types.js";
import { arredondar } from "../integrations/brindeme/mappers.js";

export interface Limite {
  min: number;
  max: number;
}

/** Onde o site muda o preço além dos limites de custo (sonda de 05/11, varredura densa de 8 produtos). */
export const DEGRAUS_DO_SITE = [100, 500, 1000, 5000];
/** Faixa de custo com max acima disto não tem teto: não há "max + 1" para consultar. */
const SEM_TETO = 1_000_000;

export function pontosDeConsulta(limites: Limite[], minimo: number): number[] {
  const pontos = new Set<number>([minimo, ...DEGRAUS_DO_SITE]);
  for (const f of limites) {
    pontos.add(f.min);
    if (f.max < SEM_TETO) pontos.add(f.max + 1);
  }
  return [...pontos].filter((q) => q >= minimo).sort((a, b) => a - b);
}

export function montarFaixasDeVenda(limites: Limite[], minimo: number, precos: Map<number, number>): PriceRange[] {
  const pontos = pontosDeConsulta(limites, minimo);
  const faixas: PriceRange[] = [];
  for (let i = 0; i < pontos.length; i++) {
    const inicio = pontos[i];
    const centavos = precos.get(inicio) ?? 0;
    if (centavos <= 0) continue;
    const fim =
      i + 1 < pontos.length ? pontos[i + 1] - 1 : limites.find((f) => inicio >= f.min && inicio <= f.max)?.max;
    if (fim === undefined) continue;
    const price = arredondar(centavos / 100);
    const anterior = faixas.at(-1);
    if (anterior && anterior.max + 1 === inicio && anterior.price === price) anterior.max = fim;
    else faixas.push({ min: inicio, max: fim, price });
  }
  return faixas;
}

/** Só uma candidata: o preço que vai ao cliente sai da consulta exata dessa quantidade. */
export function proximoDegrau(faixas: PriceRange[], quantidade: number): number | undefined {
  const atual = faixas.find((f) => quantidade >= f.min && quantidade <= f.max);
  if (!atual) return undefined;
  const mais = faixas.filter((f) => f.min > quantidade && f.price < atual.price).map((f) => f.min);
  return mais.length ? Math.min(...mais) : undefined;
}

/** Cores com as mesmas faixas de custo (limites e valor) têm o mesmo preço de venda: 45 de 45 grupos na sonda. Só em memória. */
export function chaveDoGrupo(custo: PriceRange[]): string {
  return custo.map((f) => `${f.min}-${f.max}:${Math.round(f.price * 100)}`).sort().join("|");
}

/** Id opaco por produto (g1, g2...) na ordem em que cada chave aparece: não deriva do custo, então pode ir ao disco. */
export function idsDeGrupo(chaves: string[]): string[] {
  const ids = new Map<string, string>();
  return chaves.map((c) => ids.get(c) ?? (ids.set(c, `g${ids.size + 1}`), ids.get(c)!));
}

export const limitesDe = (faixas: PriceRange[]): Limite[] => faixas.map(({ min, max }) => ({ min, max }));

/** Nos mocks a tabela vale como preço de venda; fora de toda faixa, 0 ("a consultar"). */
export function centavosNaTabela(faixas: PriceRange[], quantidade: number): number {
  const f = faixas.find((x) => quantidade >= x.min && quantidade <= x.max);
  return f ? Math.round(f.price * 100) : 0;
}
