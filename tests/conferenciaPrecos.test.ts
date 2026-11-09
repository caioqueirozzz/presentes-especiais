import { describe, it, expect } from "vitest";
import { quantidadesDeTeste, sortear, sorteador } from "../src/operacao/conferenciaPrecos.js";

describe("conferência de preços: sorteio reproduzível", () => {
  it("mesma semente, mesma sequência", () => {
    const a = sorteador(20261105);
    const b = sorteador(20261105);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("sortear devolve n itens sem repetir e sempre inclui os obrigatórios", () => {
    const lista = Array.from({ length: 50 }, (_, i) => `p${i}`);
    const r = sortear(lista, 10, sorteador(1), (x) => x === "p42" || x === "p7");
    expect(r).toHaveLength(10);
    expect(new Set(r).size).toBe(10);
    expect(r).toEqual(expect.arrayContaining(["p42", "p7"]));
  });

  it("quantidades: o mínimo sempre, e só pontos ≥ mínimo e ≤ 5000 tirados dos limites e dos degraus", () => {
    const qs = quantidadesDeTeste([{ min: 10, max: 18 }, { min: 51, max: 100 }], 10, sorteador(3), 4);
    expect(qs[0]).toBe(10);
    expect(qs).toHaveLength(4);
    expect(qs.every((q) => q >= 10 && q <= 5000)).toBe(true);
    expect(new Set(qs).size).toBe(4);
  });
});

import { decidirSaida, sondarRitmo } from "../src/operacao/conferenciaPrecos.js";

describe("conferência de preços: decisão de saída", () => {
  const ok = { conferidos: 100, puladas: 0, divergencias: 0, iguaisAoCusto: 0, falhasDaRota: 0 };
  it("tudo conferido sai 0", () => expect(decidirSaida(ok).codigo).toBe(0));
  it("zero conferido sai 1", () => expect(decidirSaida({ ...ok, conferidos: 0 }).codigo).toBe(1));
  it("puladas acima de 10% saem 1; até 10% passam", () => {
    expect(decidirSaida({ ...ok, conferidos: 90, puladas: 10 }).codigo).toBe(0);
    expect(decidirSaida({ ...ok, conferidos: 89, puladas: 11 }).codigo).toBe(1);
  });
  it("divergência, custo no índice e falha da rota saem 1", () => {
    expect(decidirSaida({ ...ok, divergencias: 1 }).codigo).toBe(1);
    expect(decidirSaida({ ...ok, iguaisAoCusto: 1 }).codigo).toBe(1);
    expect(decidirSaida({ ...ok, falhasDaRota: 1 }).codigo).toBe(1);
  });
});

describe("sonda de ritmo", () => {
  it("para no primeiro 429: não chama mais nem sobe de degrau", async () => {
    let t = 0;
    let n = 0;
    const logs: string[] = [];
    const r = await sondarRitmo({
      chamar: async () => ({ status: ++n === 3 ? 429 : 200, ms: 5, retryAfter: n === 3 ? "10" : null }),
      ritmos: [1, 2, 4],
      degrauMs: 30_000,
      pausaMs: 10_000,
      maxEmAndamento: 8,
      agora: () => t,
      dormir: async (ms) => void (t += ms),
      log: (l) => logs.push(l),
    });
    expect(r.parouEm).toBe(1);
    expect(r.ultimoBom).toBe(0);
    expect(n).toBeLessThanOrEqual(4);
    expect(logs.join("\n")).toContain("Retry-After: 10");
  });

  it("sem erro, percorre todos os degraus", async () => {
    let t = 0;
    const r = await sondarRitmo({
      chamar: async () => ({ status: 200, ms: 1 }),
      ritmos: [1, 2],
      degrauMs: 3_000,
      pausaMs: 10_000,
      maxEmAndamento: 8,
      agora: () => t,
      dormir: async (ms) => void (t += ms),
      log: () => {},
    });
    expect(r).toMatchObject({ ultimoBom: 2, parouEm: null });
  });
});
