import { describe, it, expect, afterEach, vi } from "vitest";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";
import { CacheAssinado, PgTipoStore, PgVectorStore } from "../src/catalogo/vetoresPg.js";
import { MemoryVectorStore, normalizar, type ConjuntoVetores } from "../src/catalogo/vetores.js";
import { MemoryTipoStore, type TabelaTipos } from "../src/catalogo/tipos.js";

const DIM = 1536;
/** Vetor determinístico e normalizado, para a comparação ser exata o bastante. */
const vetor = (semente: number): Float32Array => normalizar(Float32Array.from({ length: DIM }, (_, i) => Math.sin(semente * 7 + i * 0.37) + 0.1));

function conjunto(ids: string[], origem = (id: string) => `o-${id}`): Omit<ConjuntoVetores, "linhaDe"> {
  const matriz = new Float32Array(ids.length * DIM);
  ids.forEach((id, i) => matriz.set(vetor(i + id.length), i * DIM));
  return { modelo: "text-embedding-3-small", dimensao: DIM, gerado_em: "", ids, origem: Object.fromEntries(ids.map((id) => [id, origem(id)])), matriz };
}

describe("PgVectorStore", () => {
  let banco: Banco | undefined;
  afterEach(async () => {
    await banco?.fechar();
    banco = undefined;
  });

  it("vazio → null", async () => {
    banco = await bancoDeTeste();
    expect(await new PgVectorStore(banco, "produto").carregar()).toBeNull();
  });

  it("contrato: volta o mesmo que o MemoryVectorStore (ids, origem, valores a 1e-6)", async () => {
    banco = await bancoDeTeste();
    const entrada = conjunto(["p1", "p2", "p3"]);
    const memoria = new MemoryVectorStore();
    await memoria.salvar(entrada);
    const pg = new PgVectorStore(banco, "produto");
    await pg.salvar(entrada);

    const a = (await memoria.carregar())!;
    const b = (await pg.carregar())!;
    expect(b.ids).toEqual(a.ids);
    expect(b.origem).toEqual(a.origem);
    expect(b.modelo).toBe(a.modelo);
    expect(b.dimensao).toBe(DIM);
    expect(b.matriz).toHaveLength(a.matriz.length);
    for (let i = 0; i < a.matriz.length; i++) expect(Math.abs(a.matriz[i] - b.matriz[i])).toBeLessThan(1e-6);
    expect(b.linhaDe.get("p2")).toBe(1);
  });

  it("vetores de tipo: a origem é o próprio tipo", async () => {
    banco = await bancoDeTeste();
    const pg = new PgVectorStore(banco, "tipo");
    await pg.salvar(conjunto(["caneca", "camiseta"], (id) => id));
    const lido = (await new PgVectorStore(banco, "tipo").carregar())!;
    expect(lido.ids).toEqual(["camiseta", "caneca"]);
    expect(lido.origem).toEqual({ caneca: "caneca", camiseta: "camiseta" });
  });

  it("salvar troca o conjunto inteiro: sobra de antes sai", async () => {
    banco = await bancoDeTeste();
    const pg = new PgVectorStore(banco, "produto");
    await pg.salvar(conjunto(["a", "b", "c"]));
    await pg.salvar(conjunto(["b"]));
    expect((await pg.carregar())!.ids).toEqual(["b"]);
    const [{ n }] = await banco.query<{ n: number }>("SELECT count(*)::int AS n FROM agente.vetores_produto");
    expect(n).toBe(1);
  });

  it("não vai ao banco a cada pergunta; relê quando a assinatura muda, no máximo a cada 5 min", async () => {
    banco = await bancoDeTeste();
    let agora = 0;
    const leitor = new PgVectorStore(banco, "produto", () => agora);
    await leitor.salvar(conjunto(["a"]));
    const primeiro = await leitor.carregar();

    // Outro processo grava: o leitor só percebe depois dos 5 min, e relê em segundo plano.
    await new PgVectorStore(banco, "produto").salvar(conjunto(["a", "z"]));
    expect(await leitor.carregar()).toBe(primeiro);
    agora = 5 * 60_000 + 1;
    expect(await leitor.carregar()).toBe(primeiro);
    await leitor.aguardarReleitura();
    expect((await leitor.carregar())!.ids).toEqual(["a", "z"]);

    // Sem mudança no banco, a conferência não troca o objeto.
    const atual = await leitor.carregar();
    agora += 6 * 60_000;
    expect(await leitor.carregar()).toBe(atual);
    await leitor.aguardarReleitura();
    expect(await leitor.carregar()).toBe(atual);
  });

  it("depois do próprio salvar, a conferência não relê o conjunto", async () => {
    banco = await bancoDeTeste();
    let agora = 0;
    const pg = new PgVectorStore(banco, "produto", () => agora);
    await pg.salvar(conjunto(["a", "b"]));
    const salvo = await pg.carregar();
    agora = 5 * 60_000 + 1;
    await pg.carregar();
    await pg.aguardarReleitura();
    expect(await pg.carregar()).toBe(salvo);
  });

  it("salvar já enxerga o que gravou, sem esperar", async () => {
    banco = await bancoDeTeste();
    const pg = new PgVectorStore(banco, "produto", () => 0);
    await pg.salvar(conjunto(["a"]));
    await pg.carregar();
    await pg.salvar(conjunto(["a", "b"]));
    expect((await pg.carregar())!.ids).toEqual(["a", "b"]);
  });
});

describe("PgTipoStore", () => {
  let banco: Banco | undefined;
  afterEach(async () => {
    await banco?.fechar();
    banco = undefined;
  });

  const tabela: TabelaTipos = { versao: 1, produtos: { p1: { tipo: "caneca", atualizado_em: "2026-11-01" }, p2: { tipo: "camiseta", atualizado_em: "2026-11-02" } } };

  it("vazio → tabela vazia", async () => {
    banco = await bancoDeTeste();
    expect(await new PgTipoStore(banco).carregar()).toEqual({ versao: 1, produtos: {} });
  });

  it("contrato: volta o mesmo que o MemoryTipoStore", async () => {
    banco = await bancoDeTeste();
    const memoria = new MemoryTipoStore();
    await memoria.salvar(tabela);
    const pg = new PgTipoStore(banco);
    await pg.salvar(tabela);
    expect(await pg.carregar()).toEqual(await memoria.carregar());
  });

  it("salvar troca a tabela inteira (órfão sai)", async () => {
    banco = await bancoDeTeste();
    const pg = new PgTipoStore(banco);
    await pg.salvar(tabela);
    await pg.salvar({ versao: 1, produtos: { p2: { tipo: "regata", atualizado_em: "2026-11-03" } } });
    expect((await pg.carregar()).produtos).toEqual({ p2: { tipo: "regata", atualizado_em: "2026-11-03" } });
  });
});

describe("CacheAssinado", () => {
  it("duas chamadas simultâneas durante a releitura fazem uma leitura só", async () => {
    let leituras = 0;
    let liberar!: () => void;
    const portao = new Promise<void>((r) => (liberar = r));
    const cache = new CacheAssinado(
      async () => "s",
      async () => {
        leituras++;
        await portao;
        return "valor";
      },
      () => 0
    );
    const a = cache.obter();
    const b = cache.obter();
    liberar();
    expect(await Promise.all([a, b])).toEqual(["valor", "valor"]);
    expect(leituras).toBe(1);
  });

  it("definir serve o valor novo sem ir ao banco", async () => {
    let idas = 0;
    const cache = new CacheAssinado(
      async () => {
        idas++;
        return "s1";
      },
      async () => "do-banco",
      () => 0
    );
    await cache.obter();
    cache.definir("do-salvar", "s2");
    expect(await cache.obter()).toBe("do-salvar");
    expect(idas).toBe(1);
  });

  it("com o conjunto em memória, a releitura não segura a busca", async () => {
    let agora = 0;
    let sig = "s1";
    let liberar!: () => void;
    const portao = new Promise<void>((r) => (liberar = r));
    let leituras = 0;
    const cache = new CacheAssinado(
      async () => sig,
      async () => {
        if (++leituras === 1) return "v1";
        await portao;
        return "v2";
      },
      () => agora
    );
    expect(await cache.obter()).toBe("v1");
    sig = "s2";
    agora = 5 * 60_000 + 1;
    // A leitura está presa no portão e mesmo assim a busca recebe o que já tinha.
    expect(await cache.obter()).toBe("v1");
    expect(await cache.obter()).toBe("v1");
    liberar();
    await cache.aguardarReleitura();
    expect(await cache.obter()).toBe("v2");
    expect(leituras).toBe(2);
  });

  it("falha na releitura de fundo mantém o conjunto e loga", async () => {
    let agora = 0;
    let fora = false;
    const cache = new CacheAssinado(
      async () => {
        if (fora) throw Object.assign(new Error("banco fora"), { code: "ECONNREFUSED" });
        return "s";
      },
      async () => "v1",
      () => agora
    );
    await cache.obter();
    fora = true;
    agora = 5 * 60_000 + 1;
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await cache.obter()).toBe("v1");
      await cache.aguardarReleitura();
      expect(await cache.obter()).toBe("v1");
      expect(erro).toHaveBeenCalledWith(expect.stringContaining('"type":"cache_releitura_falhou"'));
      expect(erro).toHaveBeenCalledWith(expect.stringContaining('"code":"ECONNREFUSED"'));
    } finally {
      erro.mockRestore();
    }
  });

  it("sem nada em memória, a falha da 1ª carga chega a quem pediu", async () => {
    const cache = new CacheAssinado(
      async () => {
        throw new Error("banco fora");
      },
      async () => "v1",
      () => 0
    );
    await expect(cache.obter()).rejects.toThrow("banco fora");
  });

  it("leitura que começou antes do definir não sobrescreve o valor novo", async () => {
    let agora = 0;
    let sig = "s1";
    let liberar!: () => void;
    const portao = new Promise<void>((r) => (liberar = r));
    let leituras = 0;
    const cache = new CacheAssinado<string>(
      async () => sig,
      async () => {
        if (++leituras === 1) return "v1";
        await portao;
        return "velho-do-banco";
      },
      () => agora
    );
    await cache.obter();
    sig = "s2";
    agora = 5 * 60_000 + 1;
    await cache.obter();
    cache.definir("do-salvar", "s3");
    liberar();
    await cache.aguardarReleitura();
    expect(await cache.obter()).toBe("do-salvar");
  });
});
