import { describe, it, expect, afterEach } from "vitest";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";
import { PgProductIndexStore } from "../src/catalogo/indicePg.js";
import { indiceVazio, VERSAO_INDICE, type ProdutoIndexado } from "../src/catalogo/indice.js";

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
    expect(await s.sincronizadoEm()).toBe("2026-11-10T00:00:00.000Z");
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
});
