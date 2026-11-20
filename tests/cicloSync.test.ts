import { describe, it, expect, vi } from "vitest";
import { criarCicloSync, type DependenciasCiclo } from "../src/catalogo/cicloSync.js";
import { IndiceMudouError } from "../src/catalogo/indicePg.js";
import type { ResultadoSyncCatalogo } from "../src/catalogo/indice.js";
import type { ResultadoGeracao } from "../src/catalogo/geracao.js";

const sync = (): ResultadoSyncCatalogo => ({
  paginas: 1, listados: 1, ativos: 1, lidosNoDetalhe: 0, reaproveitados: 1, novos: 0, removidos: 0, falhas: [], listagemCompleta: true, completo: true,
});
const geracao = (travou = false): ResultadoGeracao => ({
  produtos: 10, rotulados: 0, reaproveitadosRotulo: 10, vetorizados: 0, reaproveitadosVetor: 10, tiposDistintos: 2, falhas: travou ? [{ id: "a", nome: "A", erro: "x" }] : [], travou, gravou: !travou,
});

function montar(sobre: Partial<DependenciasCiclo<string>> = {}) {
  const logs: string[] = [];
  const deps: DependenciasCiclo<string> = {
    sincronizar: vi.fn(async () => sync()),
    recarregar: vi.fn(async () => "indice"),
    assinatura: vi.fn(async () => "g1"),
    gerar: vi.fn(async () => geracao()),
    log: (l) => logs.push(l),
    ...sobre,
  };
  return { deps, logs, ciclo: criarCicloSync(deps, "g0") };
}

describe("criarCicloSync", () => {
  it("dois disparos com um sync lento fazem um sync só", async () => {
    let liberar!: () => void;
    const portao = new Promise<void>((r) => (liberar = r));
    const { deps, ciclo } = montar({ sincronizar: vi.fn(async () => (await portao, sync())) });
    const a = ciclo.executar();
    const b = ciclo.executar();
    liberar();
    await Promise.all([a, b]);
    expect(deps.sincronizar).toHaveBeenCalledTimes(1);
    await ciclo.executar();
    expect(deps.sincronizar).toHaveBeenCalledTimes(2);
  });

  it("sync que falha libera a guarda e não chama a geração", async () => {
    const { deps, logs, ciclo } = montar({ sincronizar: vi.fn().mockRejectedValueOnce(new Error("rede")).mockResolvedValue(sync()) });
    await ciclo.executar();
    expect(logs.join("\n")).toMatch(/Sync do catálogo falhou.*rede/);
    expect(deps.gerar).not.toHaveBeenCalled();
    await ciclo.executar();
    expect(deps.sincronizar).toHaveBeenCalledTimes(2);
  });

  it("sync bem-sucedido recarrega e gera com o índice lido", async () => {
    const { deps, ciclo } = montar();
    await ciclo.executar();
    expect(deps.gerar).toHaveBeenCalledWith("indice");
  });

  it("falha ou trava da geração não quebra o ciclo", async () => {
    const falha = montar({ gerar: vi.fn().mockRejectedValue(new Error("openai fora")) });
    await falha.ciclo.executar();
    expect(falha.logs.join("\n")).toMatch(/Geração de vetores falhou.*openai fora/);
    const trava = montar({ gerar: vi.fn(async () => geracao(true)) });
    await trava.ciclo.executar();
    expect(trava.logs.join("\n")).toMatch(/travada/);
    await trava.ciclo.executar();
    expect(trava.deps.sincronizar).toHaveBeenCalledTimes(2);
  });

  it("falha na releitura é dita como releitura, não como sync", async () => {
    const { logs, deps, ciclo } = montar({ recarregar: vi.fn().mockRejectedValue(new Error("banco")) });
    await ciclo.executar();
    expect(logs.join("\n")).toMatch(/Releitura do catálogo falhou/);
    expect(logs.join("\n")).not.toMatch(/Sync do catálogo falhou/);
    expect(deps.gerar).not.toHaveBeenCalled();
  });

  it("IndiceMudouError: loga, recarrega e não gera", async () => {
    const { deps, logs, ciclo } = montar({ sincronizar: vi.fn().mockRejectedValue(new IndiceMudouError()) });
    await ciclo.executar();
    expect(logs.join("\n")).toMatch(/mudou por fora; tenta no próximo ciclo/);
    expect(deps.recarregar).toHaveBeenCalledTimes(1);
    expect(deps.gerar).not.toHaveBeenCalled();
  });

  it("a assinatura é lida antes de recarregar", async () => {
    const ordem: string[] = [];
    const { ciclo } = montar({
      assinatura: vi.fn(async () => (ordem.push("assinatura"), "g1")),
      recarregar: vi.fn(async () => (ordem.push("recarregar"), "i")),
    });
    await ciclo.executar();
    expect(ordem).toEqual(["assinatura", "recarregar"]);
  });

  it("conferência dos 5 min: só relê se a assinatura mudou, e não durante um sync", async () => {
    const { deps, ciclo } = montar({ assinatura: vi.fn().mockResolvedValueOnce("g0").mockResolvedValue("g2") });
    await ciclo.conferirGravacaoExterna();
    expect(deps.recarregar).not.toHaveBeenCalled();
    await ciclo.conferirGravacaoExterna();
    expect(deps.recarregar).toHaveBeenCalledTimes(1);
  });
});
