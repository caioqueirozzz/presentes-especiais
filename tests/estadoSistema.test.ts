import { describe, it, expect, afterEach } from "vitest";
import {
  escreverEstadoSistema,
  invalidarCache,
  lerEstadoSistema,
} from "../src/controle/estadoSistema.js";

afterEach(() => invalidarCache());

describe("lerEstadoSistema", () => {
  it("sem nada gravado → não suspenso", () => {
    expect(lerEstadoSistema()).toEqual({ suspenso: false });
  });

  it("lê o estado gravado", async () => {
    await escreverEstadoSistema({ suspenso: true, suspensoPor: "manutencao", suspensoEm: "2026-10-17T10:00:00.000Z" });
    const e = lerEstadoSistema();
    expect(e.suspenso).toBe(true);
    expect(e.suspensoPor).toBe("manutencao");
  });

  it("lê ferramentasDesligadas", async () => {
    await escreverEstadoSistema({ suspenso: false, ferramentasDesligadas: ["preparar_orcamento"] });
    expect(lerEstadoSistema().ferramentasDesligadas).toEqual(["preparar_orcamento"]);
  });

  it("invalidarCache volta ao estado não suspenso", async () => {
    await escreverEstadoSistema({ suspenso: true });
    invalidarCache();
    expect(lerEstadoSistema().suspenso).toBe(false);
  });
});

describe("escreverEstadoSistema", () => {
  it("sem banco ligado, só atualiza o valor em memória", async () => {
    await escreverEstadoSistema({ suspenso: true, suspensoPor: "teste" });
    expect(lerEstadoSistema().suspenso).toBe(true);
  });
});
