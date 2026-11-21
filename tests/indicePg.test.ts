import { describe, it, expect, afterEach } from "vitest";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";
import { IndiceMudouError, PgProductIndexStore } from "../src/catalogo/indicePg.js";
import { indiceVazio, sincronizarCatalogo, VERSAO_INDICE, type ProdutoIndexado } from "../src/catalogo/indice.js";
import { ClienteCatalogoFalso, produto as fixture } from "./helpers/produtos.js";

const produto = (id: string, nome: string): ProdutoIndexado => ({
  id, slug: id, codigo: id, sku: id, nome, descricao: "", categorias: ["Canecas"], destaque: false,
  quantidade_minima: 10, imagem_url: null, personalizacoes: [],
  subprodutos: [{ id: `${id}-s`, sku: `${id}-s`, cor: "Branca", estoque: 100, faixas: [{ min: 10, max: 99, preco: 42.41 }] }],
  etiquetas_embutidas: [], atualizado_em: "2026-11-01", sincronizado_em: "2026-11-10T00:00:00.000Z", ausencias: 0,
});

describe("PgProductIndexStore", () => {
  let banco: Banco | undefined;
  afterEach(async () => {
    await banco?.fechar();
    banco = undefined;
  });

  it("vazio → índice vazio", async () => {
    banco = await bancoDeTeste();
    expect(await new PgProductIndexStore(banco).carregar()).toEqual(indiceVazio());
  });

  it("salva e relê o índice inteiro, com os preços", async () => {
    banco = await bancoDeTeste();
    const s = new PgProductIndexStore(banco);
    const indice = { versao: VERSAO_INDICE, sincronizado_em: "2026-11-10T00:00:00.000Z", completo: true, produtos: [produto("a", "Caneca"), produto("b", "Squeeze")] };
    await s.salvar(indice);
    expect(await s.carregar()).toEqual(indice);
  });

  it("salvar tira quem não está mais no índice", async () => {
    banco = await bancoDeTeste();
    const s = new PgProductIndexStore(banco);
    await s.salvar({ versao: VERSAO_INDICE, sincronizado_em: "t1", completo: true, produtos: [produto("a", "A"), produto("b", "B")] });
    await s.salvar({ versao: VERSAO_INDICE, sincronizado_em: "t2", completo: true, produtos: [produto("b", "B2")] });
    expect((await s.carregar()).produtos.map((p) => p.nome)).toEqual(["B2"]);
  });

  it("aguenta o tamanho do catálogo real", async () => {
    banco = await bancoDeTeste();
    const s = new PgProductIndexStore(banco);
    const produtos = Array.from({ length: 7000 }, (_, i) => produto(`p${String(i).padStart(5, "0")}`, `Produto ${i}`));
    await s.salvar({ versao: VERSAO_INDICE, sincronizado_em: "t", completo: true, produtos });
    expect((await s.carregar()).produtos).toHaveLength(7000);
  }, 60_000);

  it("versão diferente no banco → índice vazio (o próximo sync reescreve)", async () => {
    banco = await bancoDeTeste();
    await banco.query("INSERT INTO agente.catalogo_estado (id, versao, sincronizado_em, completo) VALUES (1, 1, 't', true)");
    expect(await new PgProductIndexStore(banco).carregar()).toEqual(indiceVazio());
  });

  it("recusa índice vazio: não apaga o catálogo", async () => {
    banco = await bancoDeTeste();
    const s = new PgProductIndexStore(banco);
    await s.salvar({ versao: VERSAO_INDICE, sincronizado_em: "t1", completo: true, produtos: [produto("a", "A")] });
    await expect(s.salvar({ versao: VERSAO_INDICE, sincronizado_em: "t2", completo: true, produtos: [] })).rejects.toThrow(/vazio/);
    expect((await s.carregar()).produtos.map((p) => p.id)).toEqual(["a"]);
  });

  it("ultimaGravacao muda com o conteúdo ou quando um produto sai, não num salvar idêntico", async () => {
    banco = await bancoDeTeste();
    const s = new PgProductIndexStore(banco);
    expect(await s.ultimaGravacao()).toBe(":0");
    const base = { versao: VERSAO_INDICE, sincronizado_em: "t", completo: true };
    await s.salvar({ ...base, produtos: [produto("a", "A"), produto("b", "B")] });
    const primeira = await s.ultimaGravacao();
    await s.salvar({ ...base, sincronizado_em: "t2", produtos: [produto("a", "A"), produto("b", "B")] });
    expect(await s.ultimaGravacao()).toBe(primeira);
    await s.salvar({ ...base, produtos: [produto("a", "A"), produto("b", "B2")] });
    const segunda = await s.ultimaGravacao();
    expect(segunda).not.toBe(primeira);
    await s.salvar({ ...base, produtos: [produto("a", "A")] });
    expect(await s.ultimaGravacao()).not.toBe(segunda);
  });

  it("dois salvar a partir da mesma leitura: o 2º recebe IndiceMudouError e o banco fica com o 1º", async () => {
    banco = await bancoDeTeste();
    const base = { versao: VERSAO_INDICE, sincronizado_em: "t", completo: true };
    await new PgProductIndexStore(banco).salvar({ ...base, produtos: [produto("a", "A")] });
    const s1 = new PgProductIndexStore(banco);
    const s2 = new PgProductIndexStore(banco);
    const e1 = await s1.ultimaGravacao();
    const e2 = await s2.ultimaGravacao();
    await s1.salvar({ ...base, produtos: [produto("a", "do 1º")] }, { esperada: e1 });
    await expect(s2.salvar({ ...base, produtos: [produto("a", "do 2º")] }, { esperada: e2 })).rejects.toBeInstanceOf(IndiceMudouError);
    expect((await s1.carregar()).produtos.map((p) => p.nome)).toEqual(["do 1º"]);
  });

  it("um carregar() no mesmo store entre a leitura e o salvar não esconde a gravação de outro processo", async () => {
    banco = await bancoDeTeste();
    const base = { versao: VERSAO_INDICE, sincronizado_em: "t", completo: true };
    await new PgProductIndexStore(banco).salvar({ ...base, produtos: [produto("a", "A")] });
    const s = new PgProductIndexStore(banco);
    const esperada = await s.ultimaGravacao();
    await s.carregar();
    await new PgProductIndexStore(banco).salvar({ ...base, produtos: [produto("a", "de fora")] });
    await s.carregar(); // getIndice/recarregar no meio do sync
    await expect(s.salvar({ ...base, produtos: [produto("a", "do sync")] }, { esperada })).rejects.toBeInstanceOf(IndiceMudouError);
    expect((await s.carregar()).produtos.map((p) => p.nome)).toEqual(["de fora"]);
  });

  it("sincronizarCatalogo: carregar() no meio do sync não evita o IndiceMudouError", async () => {
    banco = await bancoDeTeste();
    const base = { versao: VERSAO_INDICE, sincronizado_em: "t", completo: true };
    const s = new PgProductIndexStore(banco);
    await s.salvar({ ...base, produtos: [produto("a", "A")] });
    const client = new ClienteCatalogoFalso([fixture({ id: "a", nome: "A", atualizadoEm: "2026-11-02" })]);
    const lerDetalhe = client.getProduct.bind(client);
    client.getProduct = async (id: string) => {
      await new PgProductIndexStore(banco!).salvar({ ...base, produtos: [produto("a", "de fora")] });
      await s.carregar();
      return lerDetalhe(id);
    };
    await expect(sincronizarCatalogo(client, s)).rejects.toBeInstanceOf(IndiceMudouError);
    expect((await s.carregar()).produtos.map((p) => p.nome)).toEqual(["de fora"]);
  });

  it("salvar sem `esperada` (primeira carga) é permitido, e o mesmo store segue podendo salvar", async () => {
    banco = await bancoDeTeste();
    const s = new PgProductIndexStore(banco);
    const base = { versao: VERSAO_INDICE, sincronizado_em: "t", completo: true };
    await s.salvar({ ...base, produtos: [produto("a", "A")] });
    await s.salvar({ ...base, produtos: [produto("a", "A2")] });
    expect((await s.carregar()).produtos.map((p) => p.nome)).toEqual(["A2"]);
  });
});
