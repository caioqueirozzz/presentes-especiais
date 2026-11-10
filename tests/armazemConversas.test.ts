import { describe, it, expect, afterEach } from "vitest";
import { MemoriaConversas, PgConversas, type ArmazemConversas } from "../src/conversas/armazem.js";
import { RepositorioConversas, MAX_IDS_VISTOS } from "../src/conversas/repositorio.js";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";

const TEL = "5583999990000";
let banco: Banco | undefined;
afterEach(async () => {
  await banco?.fechar();
  banco = undefined;
});

const versoes: Array<[string, () => Promise<ArmazemConversas>]> = [
  ["memória", async () => new MemoriaConversas()],
  ["postgres", async () => new PgConversas((banco = await bancoDeTeste()))],
];

describe.each(versoes)("RepositorioConversas sobre %s", (_nome, criar) => {
  it("telefone sem registro → conversa nova e existe() falso", async () => {
    const repo = new RepositorioConversas(await criar());
    expect(await repo.existe(TEL)).toBe(false);
    const c = await repo.carregar(TEL);
    expect(c.estado.telefone).toBe(TEL);
    expect(c.estado.modo).toBe("ia");
  });

  it("salva e relê num repositório novo (reinício)", async () => {
    const armazem = await criar();
    const repo = new RepositorioConversas(armazem);
    const c = await repo.carregar(TEL);
    c.estado.modo = "humano";
    c.idsVistos.push("m1");
    await repo.salvar(c);
    const relida = await new RepositorioConversas(armazem).carregar(TEL);
    expect(relida.estado.modo).toBe("humano");
    expect(relida.idsVistos).toEqual(["m1"]);
    expect(await repo.existe(TEL)).toBe(true);
  });

  it("salvar grava o retrato da hora, não o objeto que muda depois", async () => {
    const armazem = await criar();
    const repo = new RepositorioConversas(armazem);
    const c = await repo.carregar(TEL);
    c.idsVistos.push("antes");
    const gravando = repo.salvar(c);
    c.idsVistos.push("depois");
    await gravando;
    expect((await new RepositorioConversas(armazem).carregar(TEL)).idsVistos).toEqual(["antes"]);
  });

  it("gravações seguidas da mesma conversa chegam em ordem", async () => {
    const armazem = await criar();
    const repo = new RepositorioConversas(armazem);
    const c = await repo.carregar(TEL);
    const promessas: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      c.idsVistos.push(`m${i}`);
      promessas.push(repo.salvar(c));
    }
    await Promise.all(promessas);
    expect((await new RepositorioConversas(armazem).carregar(TEL)).idsVistos.at(-1)).toBe("m19");
  });

  it("corta os ids vistos no limite", async () => {
    const armazem = await criar();
    const repo = new RepositorioConversas(armazem);
    const c = await repo.carregar(TEL);
    c.idsVistos = Array.from({ length: MAX_IDS_VISTOS + 5 }, (_, i) => `m${i}`);
    await repo.salvar(c);
    expect((await repo.carregar(TEL)).idsVistos).toHaveLength(MAX_IDS_VISTOS);
  });

  it("documento inválido é separado e vira conversa nova, com alerta", async () => {
    const armazem = await criar();
    await armazem.gravar(TEL, { versao: 1, estado: { telefone: TEL } });
    const eventos: Record<string, unknown>[] = [];
    const c = await new RepositorioConversas(armazem, (e) => eventos.push(e)).carregar(TEL);
    expect(c.turnos).toEqual([]);
    expect(eventos[0]).toMatchObject({ type: "alerta", motivo: "estado_corrompido" });
    expect(await armazem.ler(TEL)).toBeNull();
  });

  it("documento de outro telefone é tratado como corrompido", async () => {
    const armazem = await criar();
    const repo = new RepositorioConversas(armazem);
    const outra = await repo.carregar("5583888880000");
    await armazem.gravar(TEL, JSON.parse(JSON.stringify(outra)));
    expect((await repo.carregar(TEL)).estado.telefone).toBe(TEL);
    expect(await armazem.ler(TEL)).toBeNull();
  });

  it("telefone inválido é recusado antes de chegar ao armazém", async () => {
    const repo = new RepositorioConversas(await criar());
    await expect(repo.carregar("../etc")).rejects.toThrow(/telefone inválido/);
  });
});
