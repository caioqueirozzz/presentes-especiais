import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  normalizar,
  cosseno,
  cossenoNaLinha,
  montarConjunto,
  vetorDe,
  FileVectorStore,
  MemoryVectorStore,
  arquivosVetoresPadrao,
} from "../src/catalogo/vetores.js";
import {
  canonizarTipo,
  correcoesDeTipo,
  recarregarCorrecoesDeTipo,
  tipoDoProduto,
  mapaDeTipos,
  tiposDistintos,
  FileTipoStore,
  MemoryTipoStore,
  tabelaTiposVazia,
  type TabelaTipos,
} from "../src/catalogo/tipos.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ARQUIVO_CORRECOES = join(__dir, "../src/knowledge/tipos-corrigidos.json");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "vetores-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("matemática dos vetores", () => {
  it("normalizar deixa a norma em 1", () => {
    const v = normalizar([3, 4]);
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
  });

  it("vetor nulo continua nulo: não aponta direção nenhuma", () => {
    const v = normalizar([0, 0, 0]);
    expect([...v]).toEqual([0, 0, 0]);
  });

  it("cosseno vale 1 na mesma direção, 0 na perpendicular e -1 na oposta", () => {
    const a = normalizar([1, 0]);
    expect(cosseno(a, normalizar([2, 0]))).toBeCloseTo(1, 6);
    expect(cosseno(a, normalizar([0, 5]))).toBeCloseTo(0, 6);
    expect(cosseno(a, normalizar([-1, 0]))).toBeCloseTo(-1, 6);
  });

  it("cossenoNaLinha lê a linha certa da matriz", () => {
    const dimensao = 2;
    const matriz = Float32Array.from([1, 0, 0, 1]);
    const a = normalizar([1, 0]);
    expect(cossenoNaLinha(a, matriz, 0, dimensao)).toBeCloseTo(1, 6);
    expect(cossenoNaLinha(a, matriz, 1, dimensao)).toBeCloseTo(0, 6);
  });

  it("vetorDe devolve o vetor do id e null para quem não está", () => {
    const c = montarConjunto({
      modelo: "m",
      dimensao: 2,
      gerado_em: "",
      ids: ["a", "b"],
      origem: {},
      matriz: Float32Array.from([1, 0, 0, 1]),
    });
    expect([...(vetorDe(c, "b") ?? [])]).toEqual([0, 1]);
    expect(vetorDe(c, "z")).toBeNull();
  });
});

describe("FileVectorStore", () => {
  const partes = {
    modelo: "text-embedding-3-small",
    dimensao: 3,
    gerado_em: "2026-11-16T12:00:00.000Z",
    ids: ["p1", "p2"],
    origem: { p1: "2026-11-01", p2: "2026-11-02" },
    matriz: Float32Array.from([1, 0, 0, 0, 1, 0]),
  };

  it("grava e lê de volta o mesmo conjunto", async () => {
    const d = tmp();
    const store = new FileVectorStore(join(d, "v.bin"), join(d, "v.json"));
    await store.salvar(partes);

    const lido = await new FileVectorStore(join(d, "v.bin"), join(d, "v.json")).carregar();
    expect(lido).not.toBeNull();
    expect(lido!.ids).toEqual(["p1", "p2"]);
    expect(lido!.modelo).toBe("text-embedding-3-small");
    expect(lido!.dimensao).toBe(3);
    expect(lido!.origem.p2).toBe("2026-11-02");
    expect([...lido!.matriz]).toEqual([1, 0, 0, 0, 1, 0]);
    expect(vetorDe(lido!, "p2")).not.toBeNull();
  });

  it("sem arquivo devolve null (a busca cai no BM25)", async () => {
    const d = tmp();
    expect(await new FileVectorStore(join(d, "nao.bin"), join(d, "nao.json")).carregar()).toBeNull();
  });

  it("binário truncado devolve null em vez de vetor cortado", async () => {
    const d = tmp();
    const bin = join(d, "v.bin");
    const meta = join(d, "v.json");
    await new FileVectorStore(bin, meta).salvar(partes);
    writeFileSync(bin, readFileSync(bin).subarray(0, 8));
    expect(await new FileVectorStore(bin, meta).carregar()).toBeNull();
  });

  it("relê quando o arquivo muda e reaproveita enquanto não muda", async () => {
    const d = tmp();
    const bin = join(d, "v.bin");
    const meta = join(d, "v.json");
    const store = new FileVectorStore(bin, meta);
    await store.salvar(partes);

    const primeiro = await store.carregar();
    expect(await store.carregar()).toBe(primeiro);

    await store.salvar({ ...partes, ids: ["p9"], matriz: Float32Array.from([0, 0, 1]) });
    const segundo = await store.carregar();
    expect(segundo).not.toBe(primeiro);
    expect(segundo!.ids).toEqual(["p9"]);
  });

  it("o mock nunca escreve no arquivo do catálogo real", () => {
    expect(arquivosVetoresPadrao("produto", "mock").bin).not.toBe(arquivosVetoresPadrao("produto", "http").bin);
    expect(arquivosVetoresPadrao("produto", "mock").bin).toContain("-mock");
    expect(arquivosVetoresPadrao("tipo", "http").bin).not.toContain("-mock");
  });
});

describe("MemoryVectorStore", () => {
  it("guarda o que salvou", async () => {
    const store = new MemoryVectorStore();
    expect(await store.carregar()).toBeNull();
    await store.salvar({
      modelo: "m",
      dimensao: 1,
      gerado_em: "",
      ids: ["x"],
      origem: {},
      matriz: Float32Array.from([1]),
    });
    expect((await store.carregar())!.ids).toEqual(["x"]);
  });
});

describe("canonizarTipo", () => {
  it("baixa a caixa, tira acento e pontuação", () => {
    expect(canonizarTipo("CANECA.")).toBe("caneca");
    expect(canonizarTipo("  Caneta  ")).toBe("caneta");
  });

  it("leva o plural da última palavra ao singular", () => {
    expect(canonizarTipo("Canecas")).toBe("caneca");
    expect(canonizarTipo("camisetas")).toBe("camiseta");
  });

  it("não quebra palavra que termina em -s sem ser plural", () => {
    expect(canonizarTipo("porta-latas")).toBe("porta-latas");
    expect(canonizarTipo("oculos")).toBe("oculos");
  });

  it("mantém o complemento que define o objeto", () => {
    expect(canonizarTipo("Miniatura de Empilhadeira")).toBe("miniatura de empilhadeira");
    expect(canonizarTipo("miniatura de carro")).toBe("miniatura de carro");
  });

  it("texto sem letra nenhuma vira vazio", () => {
    expect(canonizarTipo("???")).toBe("");
  });
});

describe("tipos do produto", () => {
  const tabela: TabelaTipos = {
    versao: 1,
    produtos: {
      "tipo-teste-1": { tipo: "porta-latas", atualizado_em: "2026-11-01" },
      "tipo-teste-2": { tipo: "caneca", atualizado_em: "2026-11-01" },
    },
  };

  it("usa o rótulo do modelo quando não há correção", () => {
    recarregarCorrecoesDeTipo();
    expect(tipoDoProduto(tabela, "tipo-teste-1")).toBe("porta-latas");
    expect(tipoDoProduto(tabela, "desconhecido")).toBe("");
  });

  it("a correção da loja vence o rótulo do modelo, sem deploy", () => {
    const original = existsSync(ARQUIVO_CORRECOES) ? readFileSync(ARQUIVO_CORRECOES, "utf-8") : null;
    try {
      writeFileSync(ARQUIVO_CORRECOES, JSON.stringify({ tipos: { "tipo-teste-1": "Camisetas" } }), "utf-8");
      recarregarCorrecoesDeTipo();
      // canonizada na leitura: "Camisetas" vira "camiseta"
      expect(correcoesDeTipo()["tipo-teste-1"]).toBe("camiseta");
      expect(tipoDoProduto(tabela, "tipo-teste-1")).toBe("camiseta");
      expect(mapaDeTipos(tabela).get("tipo-teste-1")).toBe("camiseta");
      expect(tiposDistintos(tabela)).toEqual(["camiseta", "caneca"]);
    } finally {
      if (original !== null) writeFileSync(ARQUIVO_CORRECOES, original, "utf-8");
      recarregarCorrecoesDeTipo();
    }
  });

  it("arquivo de correções quebrado não derruba a busca", () => {
    const original = existsSync(ARQUIVO_CORRECOES) ? readFileSync(ARQUIVO_CORRECOES, "utf-8") : null;
    try {
      writeFileSync(ARQUIVO_CORRECOES, "{ isso não é json", "utf-8");
      recarregarCorrecoesDeTipo();
      expect(correcoesDeTipo()).toEqual({});
      expect(tipoDoProduto(tabela, "tipo-teste-2")).toBe("caneca");
    } finally {
      if (original !== null) writeFileSync(ARQUIVO_CORRECOES, original, "utf-8");
      recarregarCorrecoesDeTipo();
    }
  });
});

describe("FileTipoStore", () => {
  it("grava e lê a tabela", async () => {
    const d = tmp();
    const store = new FileTipoStore(join(d, "tipos.json"));
    expect((await store.carregar()).produtos).toEqual({});

    await store.salvar({ versao: 1, produtos: { a: { tipo: "caneca", atualizado_em: "2026-11-01" } } });
    const lido = await new FileTipoStore(join(d, "tipos.json")).carregar();
    expect(lido.produtos.a.tipo).toBe("caneca");
  });

  it("arquivo ilegível vira tabela vazia", async () => {
    const d = tmp();
    const file = join(d, "tipos.json");
    writeFileSync(file, "nao é json", "utf-8");
    expect((await new FileTipoStore(file).carregar()).produtos).toEqual({});
  });

  it("MemoryTipoStore guarda o que salvou", async () => {
    const store = new MemoryTipoStore();
    expect(await store.carregar()).toEqual(tabelaTiposVazia());
    await store.salvar({ versao: 1, produtos: { z: { tipo: "mochila", atualizado_em: "" } } });
    expect((await store.carregar()).produtos.z.tipo).toBe("mochila");
  });
});
