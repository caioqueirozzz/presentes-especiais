/**
 * Produtos próprios da loja, feitos sob demanda: o estoque da API não vale e qualquer quantidade a partir do
 * mínimo é aceita. A lista é local (src/knowledge/sob-demanda.json); nada é cadastrado na brinde.me.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

interface ListaSobDemanda {
  produtos: Array<{ id: string; nome: string }>;
}

function lerLista(): ListaSobDemanda {
  return JSON.parse(readFileSync(join(__dir, "../knowledge/sob-demanda.json"), "utf-8")) as ListaSobDemanda;
}

let ids: Set<string> | null = null;

export function ehSobDemanda(produtoId: string): boolean {
  ids ??= new Set(lerLista().produtos.map((p) => p.id));
  return ids.has(produtoId);
}

/** Para testes e evals; null volta à lista do arquivo. */
export function setSobDemanda(lista: string[] | null): void {
  ids = lista ? new Set(lista) : null;
}

/** Ids da lista que não estão no índice: aviso na partida, sem derrubar o agente. */
export function sobDemandaAusentes(idsNoIndice: Set<string>): Array<{ id: string; nome: string }> {
  return lerLista().produtos.filter((p) => !idsNoIndice.has(p.id));
}
