import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { comPrecoDeVenda, ClienteComPrecoDeVenda } from "../src/integrations/brindeme/clienteComPrecoDeVenda.js";
import { ErroPrecoVenda } from "../src/integrations/brindeme/precoVenda.js";
import { setLogFalhas, type FalhaDeCotacao } from "../src/catalogo/logPrecos.js";
import { produto, sub, ClienteCatalogoFalso } from "./helpers/produtos.js";

// Caneta balcão (sonda de 05/11): a roxa custa 221 centavos, as outras 230; no site saem por 774 e 792.
const caneta = () =>
  produto({
    id: "caneta",
    nome: "Caneta balcão",
    min: 50,
    subprodutos: [
      sub("azul", "Azul", 500, [[1, 9_999_999, 2.3]]),
      sub("preta", "Preta", 500, [[1, 9_999_999, 2.3]]),
      sub("roxa", "Roxa", 500, [[1, 9_999_999, 2.21]]),
      sub("verde", "Verde", 500, [[1, 9_999_999, 2.3]], false),
    ],
  });

function vitrine(falhar = new Set<string>()) {
  const chamadas: Array<{ id: string; qs: number[] }> = [];
  const consultar = async (id: string, qs: number[]) => {
    chamadas.push({ id, qs });
    if (falhar.has(id)) throw new ErroPrecoVenda("rede", "fora");
    return new Map(qs.map((q) => [q, id === "roxa" ? 774 : 792]));
  };
  return { chamadas, consultar };
}

describe("custo → preço de venda", () => {
  beforeEach(() => setLogFalhas(() => {}));
  afterEach(() => setLogFalhas(null));

  it("uma consulta por grupo de cores; a roxa (custo diferente) fica num grupo só dela", async () => {
    const { chamadas, consultar } = vitrine();
    const p = await comPrecoDeVenda(caneta(), consultar);
    expect(chamadas.map((c) => c.id).sort()).toEqual(["azul", "roxa"]);
    expect(chamadas[0].qs).toEqual([50, 100, 500, 1000, 5000]);
    const porCor = Object.fromEntries(p.subproducts.map((s) => [s.color, s.prices]));
    expect(porCor.Azul).toEqual([{ min: 50, max: 9_999_999, price: 7.92 }]);
    expect(porCor.Preta).toEqual(porCor.Azul);
    expect(porCor.Roxa).toEqual([{ min: 50, max: 9_999_999, price: 7.74 }]);
    const [azul, preta, roxa] = p.subproducts;
    expect(azul.grupo_preco).toBe("g1");
    expect(preta.grupo_preco).toBe(azul.grupo_preco);
    expect(roxa.grupo_preco).toBe("g2");
    expect(azul.limites).toEqual([{ min: 1, max: 9_999_999 }]);
  });

  it("o custo é descartado: nenhum valor de custo sobra no produto devolvido", async () => {
    const p = await comPrecoDeVenda(caneta(), vitrine().consultar);
    const precos = p.subproducts.flatMap((s) => s.prices.map((f) => f.price));
    expect(precos).not.toContain(2.3);
    expect(precos).not.toContain(2.21);
    expect(JSON.stringify(p)).not.toMatch(/"price":2\.(3|21)\b/);
  });

  it("o grupo é um id por produto: dois produtos com custos diferentes recebem g1 cada, e nada do custo vai no JSON", async () => {
    const outro = produto({ id: "outra", nome: "Outra", min: 50, subprodutos: [sub("o1", "Azul", 500, [[1, 9_999_999, 3.17]])] });
    const [a, b] = [await comPrecoDeVenda(caneta(), vitrine().consultar), await comPrecoDeVenda(outro, vitrine().consultar)];
    expect(b.subproducts[0].grupo_preco).toBe("g1");
    expect(a.subproducts[0].grupo_preco).toBe("g1");
    expect(JSON.stringify([a, b])).not.toMatch(/2\.3|2\.21|3\.17|230|221|317/);
  });

  it("cor inativa sai sem preço e sem grupo, e não é consultada", async () => {
    const { chamadas, consultar } = vitrine();
    const p = await comPrecoDeVenda(caneta(), consultar);
    const verde = p.subproducts.find((s) => s.color === "Verde")!;
    expect(verde.prices).toEqual([]);
    expect(verde.grupo_preco).toBeUndefined();
    expect(chamadas.some((c) => c.id === "verde")).toBe(false);
  });

  it("falha no grupo: prices vazio e preco_indisponivel nas cores dele; o outro grupo segue", async () => {
    const falhas: FalhaDeCotacao[] = [];
    setLogFalhas((f) => falhas.push(f));
    const p = await comPrecoDeVenda(caneta(), vitrine(new Set(["roxa"])).consultar);
    setLogFalhas(null);
    expect(falhas).toEqual([{ produto_id: "caneta", subproduto_id: "roxa", motivo: "fora" }]);
    const roxa = p.subproducts.find((s) => s.color === "Roxa")!;
    expect(roxa).toMatchObject({ prices: [], preco_indisponivel: true });
    expect(p.subproducts.find((s) => s.color === "Azul")!.preco_indisponivel).toBeUndefined();
  });

  it("cor sem faixa de custo não consulta o site e fica sem preço (o 0 cai onde não há faixa)", async () => {
    const { chamadas, consultar } = vitrine();
    const p = await comPrecoDeVenda(produto({ id: "x", nome: "X", subprodutos: [sub("s", "Única", 10, [])] }), consultar);
    expect(chamadas).toEqual([]);
    expect(p.subproducts[0]).toMatchObject({ prices: [], limites: [] });
    expect(p.subproducts[0].preco_indisponivel).toBeUndefined();
  });

  it("o cliente embrulhado aplica isso no getProduct e repassa o resto", async () => {
    const dentro = new ClienteCatalogoFalso([caneta()]);
    dentro.precoVendaFixo.set("azul", 792);
    dentro.precoVendaFixo.set("roxa", 774);
    const c = new ClienteComPrecoDeVenda(dentro);
    const p = await c.getProduct("caneta");
    expect(p.subproducts.find((s) => s.color === "Roxa")!.prices[0].price).toBe(7.74);
    expect((await c.listProducts()).data).toHaveLength(1);
    expect((await c.precoVenda("azul", [10])).get(10)).toBe(792);
  });
});
