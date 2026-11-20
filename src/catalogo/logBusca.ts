/**
 * Busca que rodou degradada: a semântica não pôde ser usada e o BM25 assumiu
 * (spec §3.6 e §5). Fica em `logs/busca.jsonl`.
 *
 * Importa ter isso no log porque a degradação é silenciosa para o cliente — ele
 * recebe uma resposta razoável, e ninguém descobriria que o filtro por tipo
 * parou de valer se não estivesse escrito em algum lugar.
 */
import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

export type MotivoDegradacao =
  | "sem_vetores"
  | "embedding_falhou"
  | "sem_vetores_de_tipo"
  | "modelo_divergente";

export interface BuscaDegradada {
  motivo: MotivoDegradacao;
  detalhe?: string;
  /** Só o tipo pedido, nunca a frase do cliente: log não é lugar de conversa. */
  tipo_pedido?: string;
}

let destino: ((e: BuscaDegradada) => void) | null = null;

/** Para testes; null volta ao arquivo. */
export function setLogBusca(f: ((e: BuscaDegradada) => void) | null): void {
  destino = f;
}

export function logarBuscaDegradada(e: BuscaDegradada): void {
  if (destino) return destino(e);
  try {
    const dir = join(__dir, "../../logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "busca.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), type: "busca_degradada", ...e })}\n`,
      "utf-8"
    );
  } catch {
    // log nunca derruba a busca
  }
}
