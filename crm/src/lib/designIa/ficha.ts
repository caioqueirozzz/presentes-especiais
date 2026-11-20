import sharp from "sharp";
import { z } from "zod";

export const Ficha = z.object({
  peca: z.string().nullable(),
  gola: z.string().nullable(),
  manga: z.string().nullable(),
  tecido_provavel: z.string().nullable(),
  elementos: z
    .array(
      z.object({
        tipo: z.enum(["logo", "estampa", "texto", "numero", "outro"]),
        conteudo: z.string().nullable(), // só para texto e número
        posicao: z.string(), // "peito esquerdo", "costas"...
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(), // px da imagem analisada
      })
    )
    .max(20),
  observacoes: z.string().nullable(),
  briefing: z.string(),
});
export type FichaIa = z.infer<typeof Ficha>;

export class FalhaIa extends Error {
  constructor(
    msg: string,
    public definitiva: boolean
  ) {
    super(msg);
  }
}

export const PROMPT_FICHA =
  'Você descreve imagens de referência de uniformes e brindes para um designer. Descreva só o que se vê. Não invente texto, marca ou cor que não esteja na imagem. Se não tiver certeza, deixe o campo nulo e explique em "observacoes". Resuma o pedido do cliente em "briefing", em 3 a 5 linhas, sem telefone, e-mail ou dado de pagamento.';

const texto = { type: "string" };
const textoOuNulo = { type: ["string", "null"] };
// strict pede todos os campos em required; o tamanho 4 do bbox é conferido pelo zod
const ESQUEMA_JSON = {
  type: "object",
  additionalProperties: false,
  required: ["peca", "gola", "manga", "tecido_provavel", "elementos", "observacoes", "briefing"],
  properties: {
    peca: textoOuNulo,
    gola: textoOuNulo,
    manga: textoOuNulo,
    tecido_provavel: textoOuNulo,
    elementos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tipo", "conteudo", "posicao", "bbox"],
        properties: {
          tipo: { type: "string", enum: ["logo", "estampa", "texto", "numero", "outro"] },
          conteudo: textoOuNulo,
          posicao: texto,
          bbox: {
            type: ["array", "null"],
            items: { type: "number" },
            description: "Caixa do elemento como [x, y, largura, altura], em pixels da imagem enviada, origem no canto superior esquerdo. Nulo se não souber.",
          },
        },
      },
    },
    observacoes: textoOuNulo,
    briefing: texto,
  },
};

export const modeloIa = () => process.env.IA_MODEL || process.env.LLM_MODEL || "gpt-4o-mini";

export async function gerarFicha(p: { imagens: Buffer[]; conversa: string; fetchFn?: typeof fetch }): Promise<{
  ficha: FichaIa;
  input_tokens: number;
  output_tokens: number;
  modelo: string;
  imagem_analisada: { largura: number; altura: number };
}> {
  const chave = process.env.OPENAI_API_KEY;
  if (!chave) throw new FalhaIa("OPENAI_API_KEY ausente", true);
  const modelo = modeloIa();

  const reduzidas = await Promise.all(
    p.imagens.map((img) =>
      sharp(img).rotate().resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true })
    )
  );
  const imagem_analisada = { largura: reduzidas[0].info.width, altura: reduzidas[0].info.height };

  const corpo = {
    model: modelo,
    messages: [
      { role: "system", content: PROMPT_FICHA },
      {
        role: "user",
        content: [
          { type: "text", text: `Conversa recente:\n${p.conversa}` },
          ...reduzidas.map((r) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${r.data.toString("base64")}` } })),
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "ficha", strict: true, schema: ESQUEMA_JSON } },
  };

  let res: Response;
  try {
    res = await (p.fetchFn ?? fetch)("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${chave}` },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new FalhaIa(`OpenAI inacessível: ${(err as Error).name}`, false);
  }
  if (!res.ok) throw new FalhaIa(`OpenAI respondeu ${res.status}`, res.status === 401 || res.status === 403);

  const dados = await res.json().catch(() => null);
  let bruto: unknown;
  try {
    bruto = JSON.parse(dados?.choices?.[0]?.message?.content ?? "");
  } catch {
    throw new FalhaIa("resposta da OpenAI não é JSON", false);
  }
  const ficha = Ficha.safeParse(bruto);
  if (!ficha.success) throw new FalhaIa("resposta da OpenAI fora do esquema", false);
  return {
    ficha: ficha.data,
    input_tokens: dados?.usage?.prompt_tokens ?? 0,
    output_tokens: dados?.usage?.completion_tokens ?? 0,
    modelo,
    imagem_analisada,
  };
}
