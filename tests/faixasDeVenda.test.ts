import { describe, it, expect } from "vitest";
import {
  centavosNaTabela,
  chaveDoGrupo,
  idsDeGrupo,
  montarFaixasDeVenda,
  pontosDeConsulta,
  proximoDegrau,
} from "../src/catalogo/faixasDeVenda.js";

// Camisa Dray Fit (PE001), números reais de 04–05/11: custo 10–18, 19–19 e 51–100; site 42,41 / 40,51 / 38,61 / 37,84.
const LIMITES_DRAY = [{ min: 10, max: 18 }, { min: 19, max: 19 }, { min: 51, max: 100 }];
const SITE_DRAY = new Map([[10, 4241], [19, 4051], [20, 0], [51, 3861], [100, 3784], [101, 0], [500, 0], [1000, 0], [5000, 0]]);

describe("faixas de venda", () => {
  it("pontos: mínimo, limites (min e max+1) e os degraus 100/500/1000/5000, a partir do mínimo", () => {
    expect(pontosDeConsulta(LIMITES_DRAY, 10)).toEqual([10, 19, 20, 51, 100, 101, 500, 1000, 5000]);
    expect(pontosDeConsulta([{ min: 1, max: 9_999_999 }], 50)).toEqual([50, 100, 500, 1000, 5000]);
  });

  it("Dray Fit: 10–18 a 42,41; 19 a 40,51; 20–50 sem faixa; 51–99 a 38,61; 100 a 37,84; 101+ sem faixa", () => {
    expect(montarFaixasDeVenda(LIMITES_DRAY, 10, SITE_DRAY)).toEqual([
      { min: 10, max: 18, price: 42.41 },
      { min: 19, max: 19, price: 40.51 },
      { min: 51, max: 99, price: 38.61 },
      { min: 100, max: 100, price: 37.84 },
    ]);
  });

  it("caneta de faixa única: degraus do site em 100, 500, 1000 e 5000; o último vai até o max da faixa de custo", () => {
    const site = new Map([[50, 792], [100, 776], [500, 768], [1000, 760], [5000, 752]]);
    expect(montarFaixasDeVenda([{ min: 1, max: 9_999_999 }], 50, site)).toEqual([
      { min: 50, max: 99, price: 7.92 },
      { min: 100, max: 499, price: 7.76 },
      { min: 500, max: 999, price: 7.68 },
      { min: 1000, max: 4999, price: 7.6 },
      { min: 5000, max: 9_999_999, price: 7.52 },
    ]);
  });

  it("faixas vizinhas com o mesmo preço se fundem e faixa com 0 não entra", () => {
    const site = new Map([[10, 500], [50, 500], [100, 0], [500, 0], [1000, 0], [5000, 0]]);
    expect(montarFaixasDeVenda([{ min: 10, max: 49 }, { min: 50, max: 99 }], 10, site)).toEqual([{ min: 10, max: 99, price: 5 }]);
  });

  it("próximo degrau: o menor início acima da quantidade com preço menor; sem faixa ou no fim, nenhum", () => {
    const faixas = montarFaixasDeVenda(LIMITES_DRAY, 10, SITE_DRAY);
    expect(proximoDegrau(faixas, 10)).toBe(19);
    expect(proximoDegrau(faixas, 19)).toBe(51);
    expect(proximoDegrau(faixas, 51)).toBe(100);
    expect(proximoDegrau(faixas, 100)).toBeUndefined();
    expect(proximoDegrau(faixas, 25)).toBeUndefined();
  });

  it("chave do grupo: mesmos limites e valor dão a mesma chave; valor diferente, outra", () => {
    const azul = [{ min: 1, max: 9_999_999, price: 2.3 }];
    const roxa = [{ min: 1, max: 9_999_999, price: 2.21 }];
    expect(chaveDoGrupo(azul)).toBe(chaveDoGrupo([{ min: 1, max: 9_999_999, price: 2.3 }]));
    expect(chaveDoGrupo(azul)).not.toBe(chaveDoGrupo(roxa));
    expect(idsDeGrupo(["x", "y", "x"])).toEqual(["g1", "g2", "g1"]);
  });

  it("centavos na tabela: preço da faixa em centavos; fora de toda faixa, 0", () => {
    const tabela = [{ min: 25, max: 99, price: 18.9 }];
    expect(centavosNaTabela(tabela, 50)).toBe(1890);
    expect(centavosNaTabela(tabela, 100)).toBe(0);
  });
});
