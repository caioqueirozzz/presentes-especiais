import { describe, it, expect, afterEach } from "vitest";
import { MemoriaModoLia, PgModoLia, type ArmazemModoLia, type ConfigLia } from "../src/whatsapp/modoLia.js";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";

const PADRAO: ConfigLia = { modo: "teste", numerosTeste: ["5583999990000"], atualizadoEm: null };
let banco: Banco | undefined;
afterEach(async () => {
  await banco?.fechar();
  banco = undefined;
});

const versoes: Array<[string, (padrao: ConfigLia) => Promise<ArmazemModoLia>]> = [
  ["memória", async (p) => new MemoriaModoLia(p)],
  ["postgres", async (p) => new PgModoLia((banco = await bancoDeTeste()), p)],
];

describe.each(versoes)("modo da Lia sobre %s", (_nome, criar) => {
  it("sem registro → padrão", async () => {
    expect(await (await criar(PADRAO)).ler()).toEqual(PADRAO);
  });

  it("salva com data e relê", async () => {
    const a = await criar(PADRAO);
    const salvo = await a.salvar({ modo: "ligada", numerosTeste: [] });
    expect(salvo.atualizadoEm).toMatch(/^\d{4}-/);
    expect(await a.ler()).toEqual(salvo);
  });
});

describe("PgModoLia", () => {
  it("registro inválido no banco → padrão", async () => {
    banco = await bancoDeTeste();
    await banco.query(`INSERT INTO agente.modo_lia (id, config) VALUES (1, '{"modo": "x"}')`);
    expect(await new PgModoLia(banco, PADRAO).ler()).toEqual(PADRAO);
  });
});
