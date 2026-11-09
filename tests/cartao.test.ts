import { describe, it, expect } from "vitest";
import { montarCartao, SEM_PRECO, CONDICAO_ESPECIAL, DEMAIS_CORES } from "../src/tools/cartao.js";
import { reais } from "../src/tools/prepararOrcamento.js";
import type { Cotacao } from "../src/catalogo/cotacao.js";

const cot = (centavos: number, proximo?: Cotacao["proximo"]): Cotacao => ({
  subproduto_id: "s",
  quantidade: 10,
  centavos,
  ...(proximo ? { proximo } : {}),
  fonte: "site",
  em: "2026-11-06T12:00:00.000Z",
});

const base = { produto_id: "dray", nome: "Camisa Dray Fit", imagem_url: "https://cdn.brinde.me/dray.webp", outras: [] as string[] };

describe("cartão do produto", () => {
  it("um preço quando todas as cores custam igual, mais o próximo degrau", () => {
    const c = montarCartao({ ...base, quantidade: 10, cotadas: [
      { cor: "Branca", cotacao: cot(4241, { quantidade: 19, centavos: 4051 }) },
      { cor: "Preta", cotacao: cot(4241, { quantidade: 19, centavos: 4051 }) },
    ] });
    expect(c).toEqual({
      produto_id: "dray",
      imagem_url: "https://cdn.brinde.me/dray.webp",
      legenda: [
        "*Camisa Dray Fit*",
        "Cores: Branca, Preta",
        `${reais(42.41)}/un para 10 un.`,
        `A partir de 19 un.: ${reais(40.51)}/un`,
      ].join("\n"),
    });
  });

  it("cor a cor quando os preços diferem, do mais barato ao mais caro", () => {
    const c = montarCartao({ ...base, quantidade: 50, cotadas: [
      { cor: "Azul", cotacao: cot(792) },
      { cor: "Roxa", cotacao: cot(774) },
      { cor: "Preta", cotacao: cot(792) },
    ] });
    expect(c.legenda).toContain(`Para 50 un.:\nRoxa: ${reais(7.74)}/un\nAzul, Preta: ${reais(7.92)}/un`);
  });

  it("sem degrau mais barato: a frase da condição especial", () => {
    expect(montarCartao({ ...base, quantidade: 100, cotadas: [{ cor: "Branca", cotacao: cot(3784) }] }).legenda).toContain(CONDICAO_ESPECIAL);
  });

  it("sem preço exato (falha ou 0): 'Valor a confirmar com a equipe.' e nenhuma condição", () => {
    const c = montarCartao({ ...base, quantidade: 25, cotadas: [
      { cor: "Branca", cotacao: { subproduto_id: "s", quantidade: 25, erro: "rede" } },
      { cor: "Preta", cotacao: cot(0) },
    ] });
    expect(c.legenda).toContain(SEM_PRECO);
    expect(c.legenda).not.toMatch(/R\$|A partir de|condição/);
  });

  it("cor com preço e cor sem preço no mesmo produto", () => {
    const c = montarCartao({ ...base, quantidade: 10, cotadas: [
      { cor: "Branca", cotacao: cot(4241) },
      { cor: "Preta", cotacao: { subproduto_id: "p", quantidade: 10, erro: "timeout" } },
    ] });
    expect(c.legenda).toContain(`${reais(42.41)}/un para 10 un.`);
    expect(c.legenda).toContain("Preta: valor a confirmar com a equipe.");
  });

  it("sem quantidade: só nome e cores, nenhum valor", () => {
    const c = montarCartao({ ...base, cotadas: [], outras: ["Branca", "Preta"] });
    expect(c.legenda).toBe("*Camisa Dray Fit*\nCores: Branca, Preta");
  });

  it("cores além das 6 conferidas aparecem pelo nome e ganham a linha 'valor confirmo quando escolher'", () => {
    const c = montarCartao({ ...base, quantidade: 10, cotadas: [{ cor: "Branca", cotacao: cot(4241) }], outras: ["Lilás"] });
    expect(c.legenda).toContain("Cores: Branca, Lilás");
    expect(c.legenda).toContain(DEMAIS_CORES);
  });

  it("nunca traz SKU nem quantidade mínima", () => {
    const c = montarCartao({ ...base, quantidade: 10, cotadas: [{ cor: "Branca", cotacao: cot(4241) }] });
    expect(c.legenda).not.toMatch(/sku|PE001|mínim|minim/i);
  });

  it("cor vazia (produto sem variação) não vira 'Cores:'", () => {
    expect(montarCartao({ ...base, quantidade: 10, cotadas: [{ cor: "", cotacao: cot(500) }] }).legenda).not.toContain("Cores:");
  });
});
