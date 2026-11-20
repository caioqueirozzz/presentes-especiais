/**
 * Embeddings de texto (`text-embedding-3-small`, 1536 dimensões).
 *
 * Usado em dois momentos bem diferentes:
 *  - na GERAÇÃO, em lotes de 100 textos, para o catálogo inteiro;
 *  - na BUSCA, um texto por vez (a consulta do cliente), com cache em memória.
 *
 * A interface `ClienteEmbeddings` existe para os testes rodarem sem rede: o
 * contrato é pequeno de propósito, só o que o projeto usa do SDK.
 */
import OpenAI from "openai";
import { normalizar } from "../catalogo/vetores.js";

export const MODELO_EMBEDDING = "text-embedding-3-small";
export const DIMENSAO_EMBEDDING = 1536;
/** Textos por chamada na geração. Acima disso a OpenAI começa a recusar por tamanho do corpo. */
export const LOTE_EMBEDDING = 100;

export interface ClienteEmbeddings {
  embeddings: {
    create(body: { model: string; input: string[] }): Promise<{ data: Array<{ embedding: number[] }> }>;
  };
}

export function clienteEmbeddingsPadrao(apiKey: string): ClienteEmbeddings {
  return new OpenAI({ apiKey }) as unknown as ClienteEmbeddings;
}

/**
 * Embeddings de um lote, já normalizados e na mesma ordem da entrada.
 * Texto vazio não vai à API: viraria um vetor que casa com qualquer coisa.
 */
export async function embeddingsDe(
  cliente: ClienteEmbeddings,
  textos: string[],
  modelo = MODELO_EMBEDDING
): Promise<Array<Float32Array | null>> {
  const saida: Array<Float32Array | null> = new Array(textos.length).fill(null);
  const pedir: Array<{ i: number; texto: string }> = [];
  textos.forEach((texto, i) => {
    const limpo = texto.trim();
    if (limpo) pedir.push({ i, texto: limpo });
  });
  if (pedir.length === 0) return saida;

  const resposta = await cliente.embeddings.create({ model: modelo, input: pedir.map((p) => p.texto) });
  pedir.forEach((p, k) => {
    const bruto = resposta.data[k]?.embedding;
    if (Array.isArray(bruto) && bruto.length > 0) saida[p.i] = normalizar(bruto);
  });
  return saida;
}

/** Um texto só. `null` quando a API não devolveu vetor para ele. */
export async function embeddingDe(
  cliente: ClienteEmbeddings,
  texto: string,
  modelo = MODELO_EMBEDDING
): Promise<Float32Array | null> {
  const [v] = await embeddingsDe(cliente, [texto], modelo);
  return v ?? null;
}

/**
 * O texto que representa o produto para a busca: o mesmo que vai ao rotulador,
 * para o vetor e o tipo enxergarem exatamente a mesma coisa.
 */
export function textoDoProduto(p: {
  nome: string;
  categorias: string[];
  descricao: string;
}): string {
  const descricao = p.descricao.replace(/\s+/g, " ").trim().slice(0, 300);
  return [p.nome, p.categorias.join(", "), descricao].map((s) => s.trim()).filter(Boolean).join(" · ");
}

/**
 * Cache de embeddings de consulta, por texto normalizado. A mesma pergunta
 * ("caneca") chega o dia inteiro; o teto evita a conversa virar vazamento de
 * memória num processo que fica semanas no ar.
 */
export class CacheEmbeddings {
  private readonly mapa = new Map<string, Float32Array>();

  constructor(private readonly teto = 2000) {}

  private chave(texto: string): string {
    return texto.toLowerCase().replace(/\s+/g, " ").trim();
  }

  obter(texto: string): Float32Array | undefined {
    return this.mapa.get(this.chave(texto));
  }

  guardar(texto: string, vetor: Float32Array): void {
    if (this.mapa.size >= this.teto) this.mapa.clear();
    this.mapa.set(this.chave(texto), vetor);
  }

  get tamanho(): number {
    return this.mapa.size;
  }
}
