/** Cotação exata diferente do índice (spec da Fase 0, 6.7): fica em logs/precos.jsonl. Valores em centavos. */
import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

export interface PrecoDivergente {
  produto_id: string;
  grupo_preco: string;
  subproduto_id: string;
  quantidade: number;
  /** null quando o índice não tinha faixa para a quantidade. */
  indice: number | null;
  site: number;
}

let destino: ((e: PrecoDivergente) => void) | null = null;

/** Para testes; null volta ao arquivo. */
export function setLogPrecos(f: ((e: PrecoDivergente) => void) | null): void {
  destino = f;
}

export interface FalhaDeCotacao {
  produto_id: string;
  subproduto_id: string;
  motivo: string;
}

let destinoFalhas: ((e: FalhaDeCotacao) => void) | null = null;

/** Para testes; null volta ao arquivo. */
export function setLogFalhas(f: ((e: FalhaDeCotacao) => void) | null): void {
  destinoFalhas = f;
}

/** Cotação que falhou na entrada do produto: o grupo fica sem preço; aqui fica o motivo (nunca o custo). */
export function logarFalhaDeCotacao(e: FalhaDeCotacao): void {
  if (destinoFalhas) return destinoFalhas(e);
  try {
    const dir = join(__dir, "../../logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "precos.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), type: "cotacao_falhou", ...e }) + "\n", "utf-8");
  } catch {
    // não-fatal
  }
}

export function logarPrecoDivergente(e: PrecoDivergente): void {
  if (destino) return destino(e);
  try {
    const dir = join(__dir, "../../logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "precos.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), type: "preco_divergente", ...e }) + "\n", "utf-8");
  } catch {
    // não-fatal
  }
}
