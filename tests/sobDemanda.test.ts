import { describe, it, expect, afterEach } from "vitest";
import { ehSobDemanda, setSobDemanda, sobDemandaAusentes } from "../src/catalogo/sobDemanda.js";
import { calcularOferta } from "../src/catalogo/oferta.js";
import { verificarSugestao } from "../src/catalogo/verificacao.js";
import { produto, sub } from "./helpers/produtos.js";

const indexado = (id: string, estoque: number) => ({
  id,
  quantidade_minima: 10,
  subprodutos: [{ id: `${id}-s`, sku: "x", cor: "Branca", estoque, faixas: [{ min: 10, max: 9999, preco: 42.41 }] }],
});

describe("sob demanda", () => {
  afterEach(() => setSobDemanda(null));

  it("a lista do repo traz só a Camisa Dray Fit e a Caneca Mágica", () => {
    expect(ehSobDemanda("afc89ae2-d187-405a-b826-d2e2ae0447f5")).toBe(true);
    expect(ehSobDemanda("dd4c5dbf-ab7d-4084-8c2b-e2f7e28669de")).toBe(true);
    expect(ehSobDemanda("prod-001")).toBe(false);
  });

  it("sob demanda passa com estoque 0 e qualquer quantidade a partir do mínimo; os outros não", () => {
    setSobDemanda(["dray"]);
    expect(calcularOferta(indexado("dray", 0), 5000)).toMatchObject({ ok: true });
    expect(calcularOferta(indexado("dray", 0), 5)).toMatchObject({ ok: false, motivo: "abaixo_do_minimo" });
    expect(calcularOferta(indexado("outro", 0), 50)).toMatchObject({ ok: false, motivo: "sem_estoque" });
    expect(calcularOferta(indexado("outro", 20), 50)).toMatchObject({ ok: false, motivo: "estoque_insuficiente" });
  });

  it("verificacao.ts concorda com oferta.ts sobre o estoque", () => {
    setSobDemanda(["dray"]);
    const sugestao = { quantidade: 100, preco_unitario: 42.41, total_estimado: 4241, cores: [{ subproduto_id: "dray-s", preco_unitario: 42.41 }] };
    const dray = produto({ id: "dray", nome: "Camisa Dray Fit", min: 10, subprodutos: [sub("dray-s", "Branca", 0, [[10, 9999, 42.41]])] });
    expect(verificarSugestao(dray, sugestao, { quantidade: 100 }).filter((v) => v.regra === "estoque")).toEqual([]);
    const outro = produto({ id: "outro", nome: "Outro", min: 10, subprodutos: [sub("dray-s", "Branca", 0, [[10, 9999, 42.41]])] });
    expect(verificarSugestao(outro, sugestao, { quantidade: 100 }).some((v) => v.regra === "estoque")).toBe(true);
  });

  it("aponta ids da lista que não estão no índice", () => {
    expect(sobDemandaAusentes(new Set(["afc89ae2-d187-405a-b826-d2e2ae0447f5"]))).toEqual([
      { id: "dd4c5dbf-ab7d-4084-8c2b-e2f7e28669de", nome: "Caneca Mágica" },
    ]);
  });
});
