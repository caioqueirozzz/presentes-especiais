/**
 * Vetores (embeddings) do catálogo — busca semântica.
 *
 * Dois conjuntos, com o mesmo formato:
 *  - vetores de PRODUTO: nome + categorias + descrição curta, um por produto;
 *  - vetores de TIPO: um por tipo distinto ("caneca", "camiseta"), poucas centenas.
 *
 * Gravação em binário (`Float32Array` contígua) porque 6,5 mil produtos × 1536
 * dimensões em JSON passariam de 100 MB e levariam segundos para ler. Em `.bin`
 * são ~40 MB lidos de uma vez; o `.json` ao lado guarda a ordem dos ids e o que
 * identifica a geração (modelo, dimensão, origem por item).
 *
 * Todos os vetores são gravados NORMALIZADOS (norma 1), então o cosseno entre
 * dois deles é o produto escalar — ver `cosseno`.
 *
 * A interface nasce assíncrona de propósito (contrato com a Fase 1, spec §9): a
 * versão Postgres/pgvector entra atrás dela sem refazer a busca. Quem busca não
 * chama `carregar()` por pergunta — recebe o retrato já carregado.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

export const VERSAO_VETORES = 1;

/** Metadados que viajam no `.json` ao lado do `.bin`. */
export interface MetaVetores {
  versao: number;
  /** Modelo de embedding que gerou a matriz (trocar o modelo invalida o arquivo). */
  modelo: string;
  dimensao: number;
  gerado_em: string;
  /** Ids na mesma ordem das linhas da matriz. */
  ids: string[];
  /**
   * Por id, o carimbo da fonte no momento da geração (`atualizado_em` do produto,
   * ou o próprio texto do tipo). É o que decide o que precisa ser regerado.
   */
  origem: Record<string, string>;
}

export interface ConjuntoVetores {
  modelo: string;
  dimensao: number;
  gerado_em: string;
  ids: string[];
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

// ---------------------------------------------------------------------------
// Versão em arquivo
// ---------------------------------------------------------------------------

/** O mock nunca escreve no arquivo do catálogo real (mesma regra do índice de produtos). */
export function arquivosVetoresPadrao(
  qual: "produto" | "tipo",
  modo: "mock" | "http"
): { bin: string; meta: string } {
  const sufixo = modo === "http" ? "" : "-mock";
  const base = join(__dir, "../../data", `vetores-${qual}${sufixo}`);
  return { bin: `${base}.bin`, meta: `${base}.json` };
}

export class FileVectorStore implements VectorStore {
  private cache: ConjuntoVetores | null = null;
  private assinatura = "";

  constructor(
    private readonly bin: string,
    private readonly meta: string
  ) {}

  private assinar(): string {
    if (!existsSync(this.bin) || !existsSync(this.meta)) return "ausente";
    const b = statSync(this.bin);
    const m = statSync(this.meta);
    return `${b.mtimeMs}:${b.size}:${m.mtimeMs}:${m.size}`;
  }

  async carregar(): Promise<ConjuntoVetores | null> {
    const atual = this.assinar();
    if (atual === this.assinatura) return this.cache;
    this.assinatura = atual;
    this.cache = atual === "ausente" ? null : this.ler();
    return this.cache;
  }

  private ler(): ConjuntoVetores | null {
    try {
      const meta = JSON.parse(readFileSync(this.meta, "utf-8")) as MetaVetores;
      if (!meta || meta.versao !== VERSAO_VETORES || !Array.isArray(meta.ids)) return null;
      const bruto = readFileSync(this.bin);
      // Arquivo truncado (queda no meio da gravação): melhor BM25 do que vetor cortado.
      if (bruto.byteLength !== meta.ids.length * meta.dimensao * 4) return null;
      // Cópia para um ArrayBuffer próprio: o Buffer do Node sai de um pool compartilhado
      // e pode não estar alinhado em 4 bytes, o que quebraria a view de Float32.
      const matriz = new Float32Array(meta.ids.length * meta.dimensao);
      Buffer.from(matriz.buffer).set(bruto);
      return montarConjunto({
        modelo: meta.modelo,
        dimensao: meta.dimensao,
        gerado_em: meta.gerado_em,
        ids: meta.ids,
        origem: meta.origem ?? {},
        matriz,
      });
    } catch {
      return null;
    }
  }

  async salvar(conjunto: Omit<ConjuntoVetores, "linhaDe">): Promise<void> {
    mkdirSync(dirname(this.bin), { recursive: true });
    const meta: MetaVetores = {
      versao: VERSAO_VETORES,
      modelo: conjunto.modelo,
      dimensao: conjunto.dimensao,
      gerado_em: conjunto.gerado_em,
      ids: conjunto.ids,
      origem: conjunto.origem,
    };
    // O .bin vai primeiro: um .json novo apontando para um .bin velho passaria na
    // conferência de tamanho e serviria vetor trocado.
    gravarAtomico(this.bin, Buffer.from(conjunto.matriz.buffer, conjunto.matriz.byteOffset, conjunto.matriz.byteLength));
    gravarAtomico(this.meta, Buffer.from(JSON.stringify(meta), "utf-8"));
    this.cache = null;
    this.assinatura = "";
  }
}

function gravarAtomico(destino: string, dados: Buffer): void {
  const tmp = `${destino}.tmp`;
  writeFileSync(tmp, dados);
  try {
    renameSync(tmp, destino);
  } catch {
    // Windows: rename falha com o arquivo aberto em outro processo (o chat lendo os vetores).
    writeFileSync(destino, dados);
    try {
      unlinkSync(tmp);
    } catch {
      // o .tmp sobrando não atrapalha a próxima geração
    }
  }
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
