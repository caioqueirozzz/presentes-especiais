/**
 * Tipo canônico do produto — busca semântica, spec §3.1.
 *
 * O tipo é o objeto em si: curto, singular, minúsculo, sem marca, cor nem
 * material. "Caneca de Porcelana Personalizada" é só "caneca". Quando o objeto
 * só se define com o complemento, ele fica: "miniatura de empilhadeira" e
 * "miniatura de carro" são tipos diferentes.
 *
 * É o que impede o porta-latas de aparecer para quem pediu camisa. O rótulo vem
 * do modelo (ver `src/llm/rotulador.ts`), mas a loja tem a última palavra:
 * `src/knowledge/tipos-corrigidos.json` vence, e vale no próximo carregamento,
 * sem deploy — mesma ideia do `etiquetas-ocasiao.json`.
 *
 * Interface assíncrona desde o começo (contrato com a Fase 1, spec §9).
 */
import { readFileSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

export const VERSAO_TIPOS = 1;

export interface TipoDoProduto {
  tipo: string;
  /** `atualizado_em` do produto quando o rótulo foi gerado: diferente, rotula de novo. */
  atualizado_em: string;
}

export interface TabelaTipos {
  versao: number;
  produtos: Record<string, TipoDoProduto>;
}

export function tabelaTiposVazia(): TabelaTipos {
  return { versao: VERSAO_TIPOS, produtos: {} };
}

export interface TipoStore {
  carregar(): Promise<TabelaTipos>;
  salvar(tabela: TabelaTipos): Promise<void>;
}

/**
 * Terminam em -s já no singular: aqui tirar o -s inventaria uma palavra.
 * Já normalizadas (sem acento), porque `canonizarTipo` compara depois do NFD.
 */
const INVARIAVEIS = new Set(["oculos", "lapis", "onibus", "atlas", "status", "pires", "fones"]);

/**
 * Deixa o rótulo na forma canônica. O modelo às vezes devolve "Canecas",
 * "CANECA." ou "caneca de porcelana" com espaço sobrando; sem isso o mesmo
 * objeto viraria tipos diferentes e o filtro passaria a depender de sorte.
 */
export function canonizarTipo(bruto: string): string {
  const limpo = bruto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!limpo) return "";
  // Plural regular do português (vogal + s: canecas, copos, camisetas), só na
  // última palavra. Palavra composta com hífen ("porta-latas") e as invariáveis
  // ("óculos", "lápis") ficam como estão: ali o -s não é plural.
  const partes = limpo.split(" ");
  const ultima = partes[partes.length - 1];
  if (/[aeiou]s$/.test(ultima) && ultima.length > 3 && !ultima.includes("-") && !INVARIAVEIS.has(ultima)) {
    partes[partes.length - 1] = ultima.replace(/s$/, "");
  }
  return partes.join(" ");
}

// ---------------------------------------------------------------------------
// Correções manuais da loja
// ---------------------------------------------------------------------------

const arquivoCorrecoes = join(__dir, "../knowledge/tipos-corrigidos.json");

let cacheCorrecoes: Record<string, string> = {};
let assinaturaCorrecoes = "";

function assinarCorrecoes(): string {
  if (!existsSync(arquivoCorrecoes)) return "ausente";
  const st = statSync(arquivoCorrecoes);
  return `${st.mtimeMs}:${st.size}`;
}

/** `produto_id → tipo`, relido quando o arquivo muda. */
export function correcoesDeTipo(): Record<string, string> {
  const atual = assinarCorrecoes();
  if (atual === assinaturaCorrecoes) return cacheCorrecoes;
  assinaturaCorrecoes = atual;
  cacheCorrecoes = {};
  if (atual !== "ausente") {
    try {
      const raw = JSON.parse(readFileSync(arquivoCorrecoes, "utf-8")) as {
        tipos?: Record<string, string>;
      };
      for (const [id, tipo] of Object.entries(raw.tipos ?? {})) {
        const canonico = canonizarTipo(String(tipo));
        if (canonico) cacheCorrecoes[id] = canonico;
      }
    } catch {
      // arquivo quebrado: segue com o rótulo do modelo, que é melhor do que derrubar a busca
    }
  }
  return cacheCorrecoes;
}

/** Só para teste: força reler o arquivo de correções. */
export function recarregarCorrecoesDeTipo(): void {
  assinaturaCorrecoes = "";
  cacheCorrecoes = {};
}

/**
 * O tipo que vale para a busca: a correção da loja, senão o rótulo do modelo.
 * Vazio quando não há nenhum dos dois — e produto sem tipo não entra no filtro.
 */
export function tipoDoProduto(tabela: TabelaTipos, produtoId: string): string {
  const correcao = correcoesDeTipo()[produtoId];
  if (correcao) return correcao;
  return tabela.produtos[produtoId]?.tipo ?? "";
}

/** Mapa `produto_id → tipo` já com as correções aplicadas, para quem percorre o catálogo inteiro. */
export function mapaDeTipos(tabela: TabelaTipos): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const [id, registro] of Object.entries(tabela.produtos)) {
    if (registro.tipo) mapa.set(id, registro.tipo);
  }
  for (const [id, tipo] of Object.entries(correcoesDeTipo())) mapa.set(id, tipo);
  return mapa;
}

/** Os tipos distintos em uso, ordenados: é a lista que ganha vetor próprio. */
export function tiposDistintos(tabela: TabelaTipos): string[] {
  return [...new Set(mapaDeTipos(tabela).values())].filter(Boolean).sort();
}

export class MemoryTipoStore implements TipoStore {
  constructor(private tabela: TabelaTipos = tabelaTiposVazia()) {}
  async carregar(): Promise<TabelaTipos> {
    return this.tabela;
  }
  async salvar(tabela: TabelaTipos): Promise<void> {
    this.tabela = tabela;
  }
}
