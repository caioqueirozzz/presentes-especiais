/** Sorteio reproduzível da conferência de preços (spec da Fase 0, 9.3). */
import { DEGRAUS_DO_SITE, type Limite } from "../catalogo/faixasDeVenda.js";

/** mulberry32: a mesma semente dá a mesma amostra, para repetir a conferência. */
export function sorteador(semente: number): () => number {
  let s = semente >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sortear<T>(lista: T[], n: number, aleatorio: () => number, sempre: (x: T) => boolean = () => false): T[] {
  const fixos = lista.filter(sempre);
  const resto = lista.filter((x) => !sempre(x));
  for (let i = resto.length - 1; i > 0; i--) {
    const j = Math.floor(aleatorio() * (i + 1));
    [resto[i], resto[j]] = [resto[j], resto[i]];
  }
  return [...fixos, ...resto].slice(0, Math.max(n, fixos.length));
}

/** teto = maior estoque do produto: acima dele nenhuma cor atende, e o agente não cota. */
export function quantidadesDeTeste(limites: Limite[], minimo: number, aleatorio: () => number, quantas = 3, teto = 5000): number[] {
  const candidatas = [...new Set([...limites.flatMap((l) => [l.min, l.max]), ...DEGRAUS_DO_SITE])].filter(
    (q) => q > minimo && q <= Math.min(teto, 5000)
  );
  return [minimo, ...sortear(candidatas, quantas - 1, aleatorio)];
}

export const FRACAO_MAXIMA_DE_PULADAS = 0.1;

export interface BalancoConferencia {
  conferidos: number;
  puladas: number;
  divergencias: number;
  iguaisAoCusto: number;
  falhasDaRota: number;
}

/** Código de saída do conferir:precos: zero conferido ou muita coisa pulada não pode passar por "100% igual". */
export function decidirSaida(b: BalancoConferencia): { codigo: 0 | 1; motivos: string[] } {
  const motivos: string[] = [];
  const tentados = b.conferidos + b.puladas;
  if (b.conferidos === 0) motivos.push("nenhum preço foi conferido");
  if (tentados > 0 && b.puladas / tentados > FRACAO_MAXIMA_DE_PULADAS) motivos.push(`${b.puladas} de ${tentados} conferências puladas (mais de 10%)`);
  if (b.divergencias > 0) motivos.push(`${b.divergencias} divergência(s) do site`);
  if (b.iguaisAoCusto > 0) motivos.push(`${b.iguaisAoCusto} preço(s) do índice igual(is) ao custo`);
  if (b.falhasDaRota > 0) motivos.push(`${b.falhasDaRota} falha(s) da rota da vitrine`);
  return { codigo: motivos.length ? 1 : 0, motivos };
}

export interface RespostaSonda {
  status: number | "erro";
  ms: number;
  retryAfter?: string | null;
}

export interface OpcoesSonda {
  chamar: () => Promise<RespostaSonda>;
  ritmos: number[];
  degrauMs: number;
  pausaMs: number;
  maxEmAndamento: number;
  agora: () => number;
  dormir: (ms: number) => Promise<void>;
  log: (linha: string) => void;
}

/** Sobe o ritmo em degraus e para no primeiro status diferente de 200: nenhuma chamada nova depois dele. */
export async function sondarRitmo(o: OpcoesSonda): Promise<{ ultimoBom: number; parouEm: number | null; chamadas: number }> {
  let ultimoBom = 0;
  let chamadas = 0;
  for (const [i, porSegundo] of o.ritmos.entries()) {
    if (i > 0) await o.dormir(o.pausaMs);
    const respostas: Promise<RespostaSonda>[] = [];
    const ruins: RespostaSonda[] = [];
    let emAndamento = 0;
    const fim = o.agora() + o.degrauMs;
    while (ruins.length === 0 && o.agora() < fim) {
      if (emAndamento >= o.maxEmAndamento) {
        await o.dormir(50);
        continue;
      }
      emAndamento++;
      chamadas++;
      respostas.push(
        o.chamar().then((r) => {
          emAndamento--;
          if (r.status !== 200) ruins.push(r);
          return r;
        })
      );
      await o.dormir(1000 / porSegundo);
    }
    const r = await Promise.all(respostas);
    const ms = r.map((x) => x.ms).sort((a, b) => a - b);
    o.log(`${porSegundo}/s: ${r.length} chamadas, ${r.length - ruins.length} ok, ${ruins.length} com 429/erro, mediana ${ms[Math.floor(ms.length / 2)]} ms`);
    if (ruins.length) {
      const retry = ruins.find((x) => x.retryAfter)?.retryAfter;
      o.log(`Parou em ${porSegundo}/s (${[...new Set(ruins.map((x) => x.status))].join(", ")})${retry ? `; Retry-After: ${retry}` : ""}.`);
      return { ultimoBom, parouEm: porSegundo, chamadas };
    }
    ultimoBom = porSegundo;
  }
  return { ultimoBom, parouEm: null, chamadas };
}
