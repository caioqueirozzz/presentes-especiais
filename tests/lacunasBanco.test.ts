import { describe, it, expect, afterEach } from "vitest";
import { MemoryLacunaStore, PgLacunaStore, type LacunaStore } from "../src/knowledge/lacunas.js";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";

let banco: Banco | undefined;
afterEach(async () => {
  await banco?.fechar();
  banco = undefined;
});

const versoes: Array<[string, () => Promise<LacunaStore>]> = [
  ["memória", async () => new MemoryLacunaStore()],
  ["postgres", async () => new PgLacunaStore((banco = await bancoDeTeste()))],
];

describe.each(versoes)("LacunaStore sobre %s", (_nome, criar) => {
  it("registra e lista na ordem", async () => {
    const s = await criar();
    await s.registrar({ pergunta: "p1", conversa_id: "c1", registrado_em: "2026-11-10T10:00:00.000Z" });
    await s.registrar({ pergunta: "p2", conversa_id: "c2", categoria_sugerida: "prazo", registrado_em: "2026-11-10T11:00:00.000Z" });
    expect(await s.listar()).toEqual([
      { pergunta: "p1", conversa_id: "c1", registrado_em: "2026-11-10T10:00:00.000Z" },
      { pergunta: "p2", conversa_id: "c2", categoria_sugerida: "prazo", registrado_em: "2026-11-10T11:00:00.000Z" },
    ]);
  });
});

describe("PgLacunaStore", () => {
  it("registrar não rejeita com o banco fora", async () => {
    banco = await bancoDeTeste();
    const s = new PgLacunaStore(banco);
    await banco.query("DROP TABLE agente.lacunas");
    await expect(s.registrar({ pergunta: "p", conversa_id: "c", registrado_em: new Date().toISOString() })).resolves.toBeUndefined();
  });
});
