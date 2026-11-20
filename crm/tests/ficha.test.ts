import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FalhaIa, gerarFicha } from "@/lib/designIa/ficha";

const FICHA = {
  peca: "camisa polo",
  gola: "polo",
  manga: "curta",
  tecido_provavel: "piquet",
  elementos: [{ tipo: "logo", conteudo: null, posicao: "peito esquerdo", bbox: [10, 20, 30, 40] }],
  observacoes: null,
  briefing: "Polo azul com logo no peito.",
};

const imagem = () => sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#0A2A66" } }).png().toBuffer();

function resposta(conteudo: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: conteudo } }], usage: { prompt_tokens: 900, completion_tokens: 120 } }), {
      status,
    })) as typeof fetch;
}

async function falha(p: Promise<unknown>): Promise<FalhaIa> {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(FalhaIa);
  return err as FalhaIa;
}

describe("gerarFicha", () => {
  const chave = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-teste";
  });
  afterEach(() => {
    process.env.OPENAI_API_KEY = chave;
  });

  it("manda imagens, conversa e esquema, e devolve a ficha validada com os tokens", async () => {
    let corpo: any = null;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      corpo = JSON.parse(String(init.body));
      return resposta(JSON.stringify(FICHA))("");
    }) as unknown as typeof fetch;
    const r = await gerarFicha({ imagens: [await imagem()], conversa: "CLIENTE: quero 50 polos", fetchFn });
    expect(corpo.model).toBeTruthy();
    expect(corpo.response_format.type).toBe("json_schema");
    const bbox = corpo.response_format.json_schema.schema.properties.elementos.items.properties.bbox;
    expect(bbox.description).toContain("[x, y, largura, altura]");
    const partes = corpo.messages[1].content;
    expect(partes[0].text).toContain("quero 50 polos");
    expect(partes[1].image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(r.ficha).toEqual(FICHA);
    expect(r.input_tokens).toBe(900);
    expect(r.output_tokens).toBe(120);
    expect(r.imagem_analisada).toEqual({ largura: 1024, altura: 512 });
  });

  it("JSON inválido é falha não definitiva", async () => {
    expect((await falha(gerarFicha({ imagens: [await imagem()], conversa: "", fetchFn: resposta("{nao é json") }))).definitiva).toBe(false);
  });

  it("JSON fora do esquema é falha não definitiva", async () => {
    const ruim = { ...FICHA, elementos: [{ ...FICHA.elementos[0], tipo: "desenho" }] };
    expect((await falha(gerarFicha({ imagens: [await imagem()], conversa: "", fetchFn: resposta(JSON.stringify(ruim)) }))).definitiva).toBe(false);
  });

  it("429 e 500 são temporárias; 401 é definitiva", async () => {
    const img = await imagem();
    expect((await falha(gerarFicha({ imagens: [img], conversa: "", fetchFn: resposta("", 429) }))).definitiva).toBe(false);
    expect((await falha(gerarFicha({ imagens: [img], conversa: "", fetchFn: resposta("", 500) }))).definitiva).toBe(false);
    expect((await falha(gerarFicha({ imagens: [img], conversa: "", fetchFn: resposta("", 401) }))).definitiva).toBe(true);
  });

  it("sem OPENAI_API_KEY falha na hora, sem chamar a OpenAI", async () => {
    process.env.OPENAI_API_KEY = "";
    let chamou = false;
    const fetchFn = (async () => {
      chamou = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect((await falha(gerarFicha({ imagens: [await imagem()], conversa: "", fetchFn }))).definitiva).toBe(true);
    expect(chamou).toBe(false);
  });

  it("timeout é falha não definitiva", async () => {
    const fetchFn = (async () => {
      throw new DOMException("tempo esgotado", "TimeoutError");
    }) as unknown as typeof fetch;
    expect((await falha(gerarFicha({ imagens: [await imagem()], conversa: "", fetchFn }))).definitiva).toBe(false);
  });
});
