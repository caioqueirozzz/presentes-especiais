import { describe, it, expect, afterEach } from "vitest";
import { estadoVazio, MemoriaEstadoPonte, normalizarEstadoPonte, PgEstadoPonte, type ArmazemPonte } from "../src/whatsapp/estadoPonte.js";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";

const TEL = "5583999990000";
let banco: Banco | undefined;
afterEach(async () => {
  await banco?.fechar();
  banco = undefined;
});

const versoes: Array<[string, () => Promise<ArmazemPonte>]> = [
  ["memória", async () => new MemoriaEstadoPonte()],
  ["postgres", async () => new PgEstadoPonte((banco = await bancoDeTeste()))],
];

describe.each(versoes)("estado da ponte sobre %s", (_nome, criar) => {
  it("sem registro → estado vazio", async () => {
    expect(await (await criar()).carregar()).toEqual(estadoVazio());
  });

  it("salva e relê", async () => {
    const a = await criar();
    const e = { ...estadoVazio(), modos: { [TEL]: "humano" as const }, concluidos: ["m1"] };
    await a.salvar(e);
    expect(await a.carregar()).toEqual(e);
  });

  it("salva de novo por cima do registro", async () => {
    const a = await criar();
    await a.salvar({ ...estadoVazio(), concluidos: ["m1"] });
    await a.salvar({ ...estadoVazio(), concluidos: ["m1", "m2"], avisosPendentes: ["resumo"] });
    expect(await a.carregar()).toMatchObject({ concluidos: ["m1", "m2"], avisosPendentes: ["resumo"] });
  });

  it("entrega parcial com foto salva e relê", async () => {
    const a = await criar();
    const partes = [{ imagem_url: "https://cdn.brinde.me/x.webp", legenda: "L" }, "texto"];
    const estado = { ...estadoVazio(), entregasParciais: { [TEL]: { ids: ["m1"], partes } } };
    await a.salvar(estado);
    expect((await a.carregar()).entregasParciais).toEqual({ [TEL]: { ids: ["m1"], partes } });
  });
});

describe("normalizarEstadoPonte", () => {
  it("estado gravado antes das entregas parciais carrega; entrada inválida é ignorada", () => {
    const { entregasParciais: _, ...antigo } = estadoVazio();
    expect(normalizarEstadoPonte(antigo).entregasParciais).toEqual({});

    const valida = { ids: ["m1"], partes: ["parte 1"] };
    const bruto = { ...antigo, entregasParciais: { [TEL]: valida, "5583000": { ids: "m1" } } };
    expect(normalizarEstadoPonte(bruto).entregasParciais).toEqual({ [TEL]: valida });
  });

  it("formato inesperado lança erro", () => {
    expect(() => normalizarEstadoPonte({ versao: 9 })).toThrow("formato inesperado");
    expect(() => normalizarEstadoPonte(null)).toThrow("formato inesperado");
  });
});

describe("PgEstadoPonte", () => {
  it("documento inválido no banco → estado vazio e alerta", async () => {
    banco = await bancoDeTeste();
    await banco.query("INSERT INTO agente.estado_ponte (id, doc) VALUES (1, '{\"versao\": 9}')");
    const eventos: Record<string, unknown>[] = [];
    expect(await new PgEstadoPonte(banco, (e) => eventos.push(e)).carregar()).toEqual(estadoVazio());
    expect(eventos[0]).toMatchObject({ motivo: "estado_da_ponte_corrompido" });
  });
});
