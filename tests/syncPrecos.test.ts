import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { esqueletoV2, recalcularPrecos, sincronizarPrecos } from "../src/catalogo/syncPrecos.js";
import { construirRegistro, FileProductIndexStore, MemoryProductIndexStore, VERSAO_INDICE, type IndiceCatalogo, type ProductIndexStore } from "../src/catalogo/indice.js";
import { ErroPrecoVenda } from "../src/integrations/brindeme/precoVenda.js";
import { produto, sub } from "./helpers/produtos.js";

const T0 = new Date("2026-11-06T03:00:00Z");
/** Uma hora depois: o aplicar só grava faixa estritamente mais nova que a do índice. */
const T1 = new Date(T0.getTime() + 3600_000);

/** n produtos, uma cor cada, grupo próprio, tabela antiga a R$ 10 entre 10 e 99. */
function indice(n: number): IndiceCatalogo {
  const produtos = Array.from({ length: n }, (_, i) =>
    construirRegistro(produto({ id: `p${i}`, nome: `P${i}`, min: 10, subprodutos: [{ ...sub(`s${i}`, "Azul", 100, [[10, 99, 10]]), grupo_preco: `g${i}` }] }), T0)
  );
  return { versao: VERSAO_INDICE, sincronizado_em: T0.toISOString(), completo: true, produtos };
}

const vitrine = (falhar = new Set<string>()) => {
  const chamadas: string[] = [];
  const consultar = async (id: string, qs: number[]) => {
    chamadas.push(id);
    if (falhar.has(id)) throw new ErroPrecoVenda("rede", "fora");
    return new Map(qs.map((q) => [q, q >= 10 && q <= 99 ? 2500 : 0]));
  };
  return { chamadas, consultar };
};

describe("sync de preços", () => {
  it("uma consulta por grupo; as faixas passam a ser as do site", async () => {
    const store = new MemoryProductIndexStore(indice(3));
    const { chamadas, consultar } = vitrine();
    const r = await sincronizarPrecos(store, consultar, { agora: T1 });
    expect(r).toMatchObject({ grupos: 3, atualizados: 3, falhas: [], gravou: true });
    expect(chamadas.sort()).toEqual(["s0", "s1", "s2"]);
    expect(store.carregar().produtos[0].subprodutos[0].faixas).toEqual([{ min: 10, max: 99, preco: 25 }]);
  });

  it("até 5% de falha: grava, e o grupo que falhou mantém as faixas anteriores", async () => {
    const store = new MemoryProductIndexStore(indice(20));
    const r = await sincronizarPrecos(store, vitrine(new Set(["s7"])).consultar, { agora: T1 });
    expect(r.gravou).toBe(true);
    expect(r.falhas).toEqual([{ produto_id: "p7", grupo_preco: "g7", erro: "fora" }]);
    const ps = store.carregar().produtos;
    expect(ps[7].subprodutos[0].faixas).toEqual([{ min: 10, max: 99, preco: 10 }]);
    expect(ps[8].subprodutos[0].faixas).toEqual([{ min: 10, max: 99, preco: 25 }]);
  });

  it("acima de 5% de falha: não grava nada", async () => {
    const antes = indice(20);
    const store = new MemoryProductIndexStore(antes);
    const r = await sincronizarPrecos(store, vitrine(new Set(["s1", "s2"])).consultar, { agora: T1 });
    expect(r.gravou).toBe(false);
    expect(store.carregar()).toBe(antes);
  });

  it("produto que entrou no índice durante o sync não some na gravação", async () => {
    let atual = indice(2);
    const store: ProductIndexStore = { carregar: () => atual, salvar: (i) => void (atual = i) };
    const { consultar } = vitrine();
    const lento = async (id: string, qs: number[]) => {
      // O sync:catalogo do agente grava um produto novo enquanto o sync de preços roda.
      if (!atual.produtos.some((p) => p.id === "p2")) atual = { ...atual, produtos: [...atual.produtos, ...indice(3).produtos.slice(2)] };
      return consultar(id, qs);
    };
    await sincronizarPrecos(store, lento, { agora: T1 });
    expect(atual.produtos.map((p) => p.id)).toEqual(["p0", "p1", "p2"]);
  });

  it("gravação atômica: no arquivo, sem sobrar .tmp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-precos-"));
    const store = new FileProductIndexStore(join(dir, "produtos-index.json"));
    store.salvar(indice(2));
    await sincronizarPrecos(store, vitrine().consultar, { agora: T1 });
    expect(readdirSync(dir)).toEqual(["produtos-index.json"]);
    expect(new FileProductIndexStore(join(dir, "produtos-index.json")).carregar().produtos[0].subprodutos[0].faixas[0].preco).toBe(25);
  });

  it("migração: o v1 (custo) vira v2 com limites e grupo, e nenhum valor de custo sobra", async () => {
    const v1 = {
      versao: 1,
      sincronizado_em: T0.toISOString(),
      completo: true,
      produtos: [{ ...indice(1).produtos[0], subprodutos: [
        { id: "s0", sku: "x", cor: "Azul", estoque: 100, faixas: [{ min: 10, max: 99, preco: 17.77 }] },
        { id: "s1", sku: "y", cor: "Roxa", estoque: 100, faixas: [{ min: 10, max: 99, preco: 17.77 }] },
      ] }],
    };
    const esqueleto = esqueletoV2(v1);
    expect(esqueleto.versao).toBe(VERSAO_INDICE);
    const [a, b] = esqueleto.produtos[0].subprodutos;
    expect(a).toMatchObject({ faixas: [], limites: [{ min: 10, max: 99 }] });
    expect(a.grupo_preco).toBe("g1");
    expect(b.grupo_preco).toBe("g1");
    const { chamadas, consultar } = vitrine();
    const r = await recalcularPrecos(esqueleto, consultar, { agora: T1 });
    expect(chamadas).toEqual(["s0"]);
    expect(JSON.stringify(r.indice)).not.toContain("17.77");
    expect(r.indice.produtos[0].subprodutos[1].faixas).toEqual([{ min: 10, max: 99, preco: 25 }]);
  });
});
