import { describe, it, expect } from "vitest";
import { PrecoVendaHttp, ErroPrecoVenda, lerPrecos } from "../src/integrations/brindeme/precoVenda.js";
import { MemoryApiLogger } from "../src/integrations/brindeme/apiLogger.js";

type Chamada = { url: string; headers: Record<string, string> };

/** fetch falso: cada chamada consome a próxima resposta do roteiro. */
function fetchFalso(roteiro: Array<() => Response | Promise<Response>>, chamadas: Chamada[]) {
  return (async (url: string, init?: RequestInit) => {
    chamadas.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const proxima = roteiro.shift();
    if (!proxima) throw new Error("roteiro acabou");
    return proxima();
  }) as unknown as typeof fetch;
}

const json = (corpo: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(corpo), { status, headers });

function vitrine(roteiro: Array<() => Response | Promise<Response>>, chamadas: Chamada[] = [], extra: { agora?: () => number } = {}) {
  const esperas: number[] = [];
  const v = new PrecoVendaHttp({
    fetch: fetchFalso(roteiro, chamadas),
    apiLogger: new MemoryApiLogger(),
    dormir: async (ms) => void esperas.push(ms),
    ...extra,
  });
  return { v, esperas, chamadas };
}

describe("rota de preço da vitrine (app3)", () => {
  it("200: centavos por quantidade, com o cabeçalho domain e a quantidade no caminho", async () => {
    const { v, chamadas } = vitrine([json({ prices: { "10": 4241, "25": 0 } })]);
    const r = await v.consultar("sub-1", [25, 10, 10]);
    expect([...r]).toEqual([[10, 4241], [25, 0]]);
    expect(chamadas[0].url).toBe("https://app3.brinde.me/api/subproduct/sub-1/price/10,25?domain=presentesespeciais.com.br");
    expect(chamadas[0].headers.domain).toBe("presentesespeciais.com.br");
  });

  it("0 é mantido como 0 (a consultar)", async () => {
    const { v } = vitrine([json({ prices: { "100": 0 } })]);
    expect((await v.consultar("s", [100])).get(100)).toBe(0);
  });

  it("404 em HTML é formato, com status 404, e não abre o disjuntor", async () => {
    const html = () => new Response("<html>not found</html>", { status: 404 });
    const { v } = vitrine([html, html, html, html, html, html]);
    for (let i = 0; i < 6; i++) {
      await expect(v.consultar("x", [10])).rejects.toMatchObject({ motivo: "formato", status: 404 });
    }
    expect(v.disjuntor.estado).toBe("fechado");
  });

  it("resposta que não é JSON e quantidade ausente são formato", async () => {
    const { v } = vitrine([() => new Response("ok", { status: 200 }), json({ prices: { "10": 4241 } })]);
    await expect(v.consultar("s", [10])).rejects.toMatchObject({ motivo: "formato" });
    await expect(v.consultar("s", [10, 25])).rejects.toMatchObject({ motivo: "formato" });
  });

  it("valor que não é inteiro ≥ 0 é formato (string, negativo, fração)", () => {
    expect(lerPrecos('{"prices":{"10":"4241"}}', [10])).toBeNull();
    expect(lerPrecos('{"prices":{"10":-1}}', [10])).toBeNull();
    expect(lerPrecos('{"prices":{"10":42.4}}', [10])).toBeNull();
  });

  it("429 espera o Retry-After e tenta de novo; 4 vezes 429 é limite", async () => {
    const r429 = json({}, 429, { "retry-after": "2" });
    const a = vitrine([r429, json({ prices: { "10": 1 } })]);
    expect((await a.v.consultar("s", [10])).get(10)).toBe(1);
    expect(a.esperas).toEqual([2000]);

    const b = vitrine([json({}, 429), json({}, 429), json({}, 429), json({}, 429)]);
    await expect(b.v.consultar("s", [10])).rejects.toMatchObject({ motivo: "limite" });
    expect(b.esperas).toEqual([10_000, 10_000, 10_000]);
  });

  it("5xx tenta mais uma vez; duas vezes é rede", async () => {
    const a = vitrine([json({}, 502), json({ prices: { "10": 7 } })]);
    expect((await a.v.consultar("s", [10])).get(10)).toBe(7);
    const b = vitrine([json({}, 500), json({}, 500)]);
    await expect(b.v.consultar("s", [10])).rejects.toMatchObject({ motivo: "rede" });
  });

  it("timeout vira motivo timeout", async () => {
    const { v } = vitrine([() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }))]);
    await expect(v.consultar("s", [10])).rejects.toMatchObject({ motivo: "timeout" });
  });

  it("corpo que trava depois dos cabeçalhos vira timeout", async () => {
    const travada = () => {
      const r = new Response("{}", { status: 200 });
      Object.defineProperty(r, "text", { value: () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })) });
      return r;
    };
    const { v } = vitrine([travada]);
    await expect(v.consultar("s", [10])).rejects.toMatchObject({ motivo: "timeout" });
  });

  it("disjuntor: 5 falhas seguidas abrem por 2 min e a chamada falha na hora com indisponivel", async () => {
    let t = 0;
    const falha = json({}, 500);
    const { v, chamadas } = vitrine([falha, falha, falha, falha, falha, json({ prices: { "10": 3 } })], [], { agora: () => t });
    for (let i = 0; i < 3; i++) await expect(v.consultar("s", [10])).rejects.toBeInstanceOf(ErroPrecoVenda);
    expect(chamadas).toHaveLength(5);
    await expect(v.consultar("s", [10])).rejects.toMatchObject({ motivo: "indisponivel" });
    expect(chamadas).toHaveLength(5);
    t += 2 * 60_000;
    expect((await v.consultar("s", [10])).get(10)).toBe(3);
  });

  it("mais de 60 quantidades vão em lotes de 60", async () => {
    const qs = Array.from({ length: 61 }, (_, i) => i + 1);
    const corpo = (de: number, ate: number) => ({ prices: Object.fromEntries(qs.slice(de, ate).map((q) => [String(q), q])) });
    const { v, chamadas } = vitrine([json(corpo(0, 60)), json(corpo(60, 61))]);
    const r = await v.consultar("s", qs);
    expect(r.size).toBe(61);
    expect(chamadas).toHaveLength(2);
  });
});
