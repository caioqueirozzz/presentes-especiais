import { describe, it, expect, afterEach, vi } from "vitest";
import { escreverEstadoSistema, invalidarCache, lerEstadoSistema, ligarEstadoSistema } from "../src/controle/estadoSistema.js";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";

describe("estado do sistema no banco", () => {
  let banco: Banco | undefined;
  let parar: (() => void) | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    parar?.();
    invalidarCache();
    await banco?.fechar();
    banco = undefined;
  });

  it("sem registro → não suspenso", async () => {
    banco = await bancoDeTeste();
    parar = await ligarEstadoSistema(banco, 60_000);
    expect(lerEstadoSistema()).toEqual({ suspenso: false });
  });

  it("o que um processo grava, o outro lê na releitura", async () => {
    banco = await bancoDeTeste();
    parar = await ligarEstadoSistema(banco, 10);
    await banco.query(`INSERT INTO agente.estado_sistema (id, estado) VALUES (1, '{"suspenso": true, "suspensoPor": "teste"}')`);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(lerEstadoSistema()).toMatchObject({ suspenso: true, suspensoPor: "teste" });
  });

  it("escrever vale na hora e fica no banco", async () => {
    banco = await bancoDeTeste();
    parar = await ligarEstadoSistema(banco, 60_000);
    await escreverEstadoSistema({ suspenso: true, suspensoPor: "atendente" });
    expect(lerEstadoSistema().suspenso).toBe(true);
    const [linha] = await banco.query<{ estado: { suspenso: boolean } }>("SELECT estado FROM agente.estado_sistema");
    expect(linha.estado.suspenso).toBe(true);
  });

  it("falha de leitura mantém o último estado (não dessuspende sozinho)", async () => {
    banco = await bancoDeTeste();
    parar = await ligarEstadoSistema(banco, 10);
    await escreverEstadoSistema({ suspenso: true });
    await banco.query("DROP TABLE agente.estado_sistema");
    await new Promise((ok) => setTimeout(ok, 50));
    expect(lerEstadoSistema().suspenso).toBe(true);
  });

  it("registro com formato inválido → não suspenso", async () => {
    banco = await bancoDeTeste();
    await banco.query(`INSERT INTO agente.estado_sistema (id, estado) VALUES (1, '{"suspenso": "sim"}')`);
    parar = await ligarEstadoSistema(banco, 60_000);
    expect(lerEstadoSistema()).toEqual({ suspenso: false });
  });

  it("primeira leitura falha → ligarEstadoSistema rejeita (não sobe como ativo)", async () => {
    banco = await bancoDeTeste();
    await banco.query("DROP TABLE agente.estado_sistema");
    await expect(ligarEstadoSistema(banco, 60_000)).rejects.toThrow();
  });

  it("escrita durante uma releitura em voo não é sobrescrita pelo valor antigo", async () => {
    banco = await bancoDeTeste();
    const real = banco;
    let segurar = false;
    let selectIniciado!: () => void;
    const iniciou = new Promise<void>((ok) => (selectIniciado = ok));
    let soltar!: () => void;
    const portao = new Promise<void>((ok) => (soltar = ok));
    const lento = {
      ...real,
      query: async (sql: string, params?: unknown[]) => {
        const r = await real.query(sql, params);
        if (segurar && sql.startsWith("SELECT")) {
          selectIniciado();
          await portao;
        }
        return r;
      },
    } as Banco;
    // Só o setInterval é falso: nenhuma releitura "cura" o estado, só a que o teste dispara.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    parar = await ligarEstadoSistema(lento, 60_000);
    segurar = true;
    vi.advanceTimersByTime(60_000); // dispara exatamente uma releitura
    await iniciou; // o SELECT já leu "sem registro" e está parado
    await escreverEstadoSistema({ suspenso: true, suspensoPor: "atendente" });
    soltar();
    await new Promise((ok) => setImmediate(ok));
    await new Promise((ok) => setImmediate(ok));
    expect(lerEstadoSistema().suspenso).toBe(true);
  });

  it("escrita que falha deixa o estado anterior e propaga o erro", async () => {
    banco = await bancoDeTeste();
    parar = await ligarEstadoSistema(banco, 60_000);
    await banco.query("DROP TABLE agente.estado_sistema");
    await expect(escreverEstadoSistema({ suspenso: true })).rejects.toThrow();
    expect(lerEstadoSistema().suspenso).toBe(false);
  });

  it("ligar duas vezes deixa uma releitura só", async () => {
    banco = await bancoDeTeste();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await ligarEstadoSistema(banco, 20);
    parar = await ligarEstadoSistema(banco, 20);
    expect(vi.getTimerCount()).toBe(1);
  });
});
