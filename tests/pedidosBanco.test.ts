import { describe, it, expect, afterEach } from "vitest";
import { MemoryOrderIndexStore, PgOrderIndexStore, type OrderIndexStore } from "../src/integrations/brindeme/orderIndex.js";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";

let banco: Banco | undefined;
afterEach(async () => {
  await banco?.fechar();
  banco = undefined;
});

const versoes: Array<[string, () => Promise<OrderIndexStore>]> = [
  ["memória", async () => new MemoryOrderIndexStore()],
  ["postgres", async () => new PgOrderIndexStore((banco = await bancoDeTeste()))],
];

const P = (id: string, codigo: string) => ({
  id, codigo, telefone: "5583999990000", email: "a@b.com", status: "aberto",
  criado_em: "2026-11-01T00:00:00.000Z", sincronizado_em: "2026-11-10T00:00:00.000Z",
});

describe.each(versoes)("OrderIndexStore sobre %s", (_nome, criar) => {
  it("vazio no começo", async () => {
    expect(await (await criar()).carregar()).toEqual([]);
  });

  it("salvar substitui a lista inteira", async () => {
    const s = await criar();
    await s.salvar([P("1", "A1"), P("2", "A2")]);
    await s.salvar([P("2", "A2-novo")]);
    expect(await s.carregar()).toEqual([P("2", "A2-novo")]);
  });
});
