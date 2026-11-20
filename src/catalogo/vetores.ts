/**
 * Vetores (embeddings) do catálogo — busca semântica.
 *
 * Dois conjuntos, com o mesmo formato:
 *  - vetores de PRODUTO: nome + categorias + descrição curta, um por produto;
 *  - vetores de TIPO: um por tipo distinto ("caneca", "camiseta"), poucas centenas.
 *
 * Em memória o conjunto é uma `Float32Array` contígua (6,5 mil produtos × 1536
 * dimensões); no banco vive em `agente.vetores_*` (ver `vetoresPg.ts`).
 *
 * Todos os vetores são gravados NORMALIZADOS (norma 1), então o cosseno entre
 * dois deles é o produto escalar — ver `cosseno`.
 *
 * A interface nasce assíncrona de propósito (contrato com a Fase 1, spec §9): a
 * versão Postgres/pgvector entra atrás dela sem refazer a busca. Quem busca não
 * chama `carregar()` por pergunta — recebe o retrato já carregado.
 */
export interface ConjuntoVetores {
  /** Modelo de embedding que gerou a matriz (trocar o modelo invalida o conjunto). */
  modelo: string;
  dimensao: number;
  gerado_em: string;
  /** Ids na mesma ordem das linhas da matriz. */
  ids: string[];
  /** Por id, o carimbo da fonte na geração (`atualizado_em` do produto, ou o texto do tipo): decide o que regerar. */
  origem: Record<string, string>;
  /** `ids.length * dimensao` floats, linha i = vetor de `ids[i]`, já normalizado. */
  matriz: Float32Array;
  /** id → índice da linha. */
  linhaDe: Map<string, number>;
}

export interface VectorStore {
  /** `null` quando não há arquivo (a busca cai no BM25 e loga uma vez). */
  carregar(): Promise<ConjuntoVetores | null>;
  salvar(conjunto: Omit<ConjuntoVetores, "linhaDe">): Promise<void>;
}

// ---------------------------------------------------------------------------
// Matemática
// ---------------------------------------------------------------------------

/** Divide pelo próprio comprimento. Vetor nulo volta nulo: não aponta direção nenhuma. */
export function normalizar(v: Float32Array | number[]): Float32Array {
  const origem = v instanceof Float32Array ? v : Float32Array.from(v);
  let soma = 0;
  for (let i = 0; i < origem.length; i++) soma += origem[i] * origem[i];
  const norma = Math.sqrt(soma);
  if (norma === 0) return new Float32Array(origem.length);
  const r = new Float32Array(origem.length);
  for (let i = 0; i < origem.length; i++) r[i] = origem[i] / norma;
  return r;
}

/**
 * Cosseno entre `a` e a linha `linha` da matriz. Os dois lados já estão
 * normalizados, então é só o produto escalar — e é este laço que roda uma vez
 * por produto a cada busca, por isso sem alocação nenhuma aqui dentro.
 */
export function cossenoNaLinha(a: Float32Array, matriz: Float32Array, linha: number, dimensao: number): number {
  const base = linha * dimensao;
  let soma = 0;
  for (let i = 0; i < dimensao; i++) soma += a[i] * matriz[base + i];
  return soma;
}

/** Cosseno entre dois vetores normalizados soltos. */
export function cosseno(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let soma = 0;
  for (let i = 0; i < n; i++) soma += a[i] * b[i];
  return soma;
}

/** Monta o conjunto (com o índice por id) a partir das partes lidas ou geradas. */
export function montarConjunto(partes: Omit<ConjuntoVetores, "linhaDe">): ConjuntoVetores {
  const linhaDe = new Map<string, number>();
  partes.ids.forEach((id, i) => linhaDe.set(id, i));
  return { ...partes, linhaDe };
}

/** O vetor de um id, como cópia (quem chama pode guardar sem prender a matriz). */
export function vetorDe(conjunto: ConjuntoVetores, id: string): Float32Array | null {
  const linha = conjunto.linhaDe.get(id);
  if (linha === undefined) return null;
  const base = linha * conjunto.dimensao;
  return conjunto.matriz.slice(base, base + conjunto.dimensao);
}

export class MemoryVectorStore implements VectorStore {
  constructor(private conjunto: ConjuntoVetores | null = null) {}
  async carregar(): Promise<ConjuntoVetores | null> {
    return this.conjunto;
  }
  async salvar(partes: Omit<ConjuntoVetores, "linhaDe">): Promise<void> {
    this.conjunto = montarConjunto(partes);
  }
}
