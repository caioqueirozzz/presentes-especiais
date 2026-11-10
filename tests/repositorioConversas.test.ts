import { describe, it, expect, beforeEach } from "vitest";
import { MemoriaConversas } from "../src/conversas/armazem.js";
import { MAX_IDS_VISTOS, MAX_TURNOS_GUARDADOS, RepositorioConversas } from "../src/conversas/repositorio.js";

const TEL = "5583999990000";

// Reinício, ordem, corrompido e telefone inválido: tests/armazemConversas.test.ts.
describe("RepositorioConversas", () => {
  let armazem: MemoriaConversas;
  beforeEach(() => {
    armazem = new MemoriaConversas();
  });

  it("as últimas opções apresentadas sobrevivem ao reinício", async () => {
    const repo = new RepositorioConversas(armazem);
    const c = await repo.carregar(TEL);
    c.estado.ultimasOpcoes = [{ id: "caneca", nome: "Caneca de Porcelana" }];
    await repo.salvar(c);
    expect((await new RepositorioConversas(armazem).carregar(TEL)).estado.ultimasOpcoes).toEqual([
      { id: "caneca", nome: "Caneca de Porcelana" },
    ]);
  });

  it("guarda só os últimos turnos e ids", async () => {
    const repo = new RepositorioConversas(armazem);
    const c = await repo.carregar(TEL);
    for (let i = 0; i < MAX_TURNOS_GUARDADOS + 5; i++) {
      c.turnos.push({ turnoId: `t${i}`, resposta: { respostas: [], modo: "ia" } });
    }
    for (let i = 0; i < MAX_IDS_VISTOS + 5; i++) c.idsVistos.push(`m${i}`);
    await repo.salvar(c);
    const relida = await repo.carregar(TEL);
    expect(relida.turnos).toHaveLength(MAX_TURNOS_GUARDADOS);
    expect(relida.turnos[0].turnoId).toBe("t5");
    expect(relida.idsVistos).toHaveLength(MAX_IDS_VISTOS);
  });

  it("histórico, arquivos recebidos e falhas guardados têm teto", async () => {
    const repo = new RepositorioConversas(armazem);
    const c = await repo.carregar(TEL);
    for (let i = 0; i < 250; i++) c.estado.historico.push({ role: "user", content: `m${i}`, timestamp: "2026-10-14T12:00:00.000Z" });
    c.estado.arquivosRecebidos = Array.from({ length: 60 }, (_, i) => ({ nome: `a${i}.png`, caminho: `c${i}`, mime: "image/png", bytes: 1 }));
    for (let i = 0; i < 60; i++) c.falhasPorTurno[`t${i}`] = 1;
    await repo.salvar(c);
    const relida = await repo.carregar(TEL);
    expect(relida.estado.historico).toHaveLength(200);
    expect(relida.estado.historico.at(-1)?.content).toBe("m249");
    expect(relida.estado.arquivosRecebidos).toHaveLength(50);
    expect(Object.keys(relida.falhasPorTurno)).toHaveLength(50);
  });

  it("turno guardado no formato antigo (sem ids) continua válido", async () => {
    const repo = new RepositorioConversas(armazem);
    const c = await repo.carregar(TEL);
    c.turnos.push({ turnoId: "0123456789abcdef", resposta: { respostas: ["x"], modo: "ia" } });
    await repo.salvar(c);
    expect((await new RepositorioConversas(armazem).carregar(TEL)).turnos).toHaveLength(1);
  });
});
