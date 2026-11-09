import { describe, it, expect } from "vitest";
import { cotarAoVivo, cotacaoValida, guardarCotacoes, cotou, type Cotacao } from "../src/catalogo/cotacao.js";
import { ErroPrecoVenda } from "../src/integrations/brindeme/precoVenda.js";
import { createInitialState } from "../src/agent/state.js";

const T0 = new Date("2026-11-06T12:00:00Z");

function vitrine(tabela: Record<string, Record<number, number>>, latenciaMs = 0) {
  const chamadas: Array<{ id: string; qs: number[] }> = [];
  let emVoo = 0;
  let maximo = 0;
  return {
    chamadas,
    maximo: () => maximo,
    precoVenda: async (id: string, qs: number[]) => {
      chamadas.push({ id, qs });
      emVoo++;
      maximo = Math.max(maximo, emVoo);
      try {
        if (latenciaMs) await new Promise((r) => setTimeout(r, latenciaMs));
        if (!tabela[id]) throw new ErroPrecoVenda("rede", "fora");
        return new Map(qs.map((q) => [q, tabela[id][q] ?? 0]));
      } finally {
        emVoo--;
      }
    },
  };
}

describe("cotação exata ao vivo", () => {
  it("uma chamada por cor, com o próximo degrau na mesma chamada", async () => {
    const v = vitrine({ branca: { 10: 4241, 19: 4051 }, preta: { 10: 4241, 19: 4051 } });
    const r = await cotarAoVivo(v, [
      { subprodutoId: "branca", quantidade: 10, proximoDegrau: 19 },
      { subprodutoId: "preta", quantidade: 10, proximoDegrau: 19 },
    ], () => T0);
    expect(v.chamadas).toEqual([{ id: "branca", qs: [10, 19] }, { id: "preta", qs: [10, 19] }]);
    expect(r[0]).toEqual({ subproduto_id: "branca", quantidade: 10, centavos: 4241, proximo: { quantidade: 19, centavos: 4051 }, fonte: "site", em: T0.toISOString() });
  });

  it("o degrau só entra se for mais barato e tiver preço", async () => {
    const v = vitrine({ s: { 10: 4241, 100: 4241, 500: 0 } });
    const [a] = await cotarAoVivo(v, [{ subprodutoId: "s", quantidade: 10, proximoDegrau: 100 }]);
    const [b] = await cotarAoVivo(v, [{ subprodutoId: "s", quantidade: 10, proximoDegrau: 500 }]);
    expect(cotou(a)).toBe(true);
    expect(cotou(b)).toBe(true);
    expect(cotou(a) && a.proximo).toBeFalsy();
    expect(cotou(b) && b.proximo).toBeFalsy();
  });

  it("falha vira FalhaCotacao com o motivo; 0 é cotação 'a consultar'", async () => {
    const v = vitrine({ s: { 25: 0 } });
    const [falhou, zero] = await cotarAoVivo(v, [{ subprodutoId: "fora", quantidade: 10 }, { subprodutoId: "s", quantidade: 25 }]);
    expect(falhou).toEqual({ subproduto_id: "fora", quantidade: 10, erro: "rede" });
    expect(cotou(zero) && zero.centavos).toBe(0);
  });

  it("no máximo 6 em paralelo", async () => {
    const tabela = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, { 10: 100 }]));
    const v = vitrine(tabela, 5);
    await cotarAoVivo(v, Object.keys(tabela).map((id) => ({ subprodutoId: id, quantidade: 10 })));
    expect(v.maximo()).toBe(6);
  });

  it("guardada vale 1 h, só para a mesma cor e quantidade e só com fonte site", () => {
    const state = createInitialState("5583999990000");
    const c: Cotacao = { subproduto_id: "s", quantidade: 10, centavos: 4241, fonte: "site", em: T0.toISOString() };
    guardarCotacoes(state, [c], T0);
    expect(cotacaoValida(state, "s", 10, new Date(T0.getTime() + 59 * 60_000))).toEqual(c);
    expect(cotacaoValida(state, "s", 10, new Date(T0.getTime() + 60 * 60_000))).toBeUndefined();
    expect(cotacaoValida(state, "s", 25, T0)).toBeUndefined();
    expect(cotacaoValida(state, "outra", 10, T0)).toBeUndefined();
    state.cotacoes!["s:10"] = { ...c, fonte: "indice" as "site" };
    expect(cotacaoValida(state, "s", 10, T0)).toBeUndefined();
  });

  it("guardar descarta as vencidas", () => {
    const state = createInitialState("5583999990000");
    guardarCotacoes(state, [{ subproduto_id: "velha", quantidade: 1, centavos: 1, fonte: "site", em: T0.toISOString() }], T0);
    guardarCotacoes(state, [], new Date(T0.getTime() + 2 * 3_600_000));
    expect(state.cotacoes).toEqual({});
  });
});
