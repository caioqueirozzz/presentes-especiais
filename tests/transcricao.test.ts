import { describe, expect, it } from "vitest";
import { PROMPT_TRANSCRICAO, transcritorOpenAI, type ClienteTranscricao } from "../src/whatsapp/transcricao.js";

const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]);

function cliente(respostas: Array<string | Error>) {
  const chamadas: Array<Record<string, unknown>> = [];
  const c: ClienteTranscricao = {
    audio: {
      transcriptions: {
        create: async (p) => {
          chamadas.push(p);
          const r = respostas.shift();
          if (r instanceof Error) throw r;
          return r ?? "";
        },
      },
    },
  };
  return { c, chamadas };
}

function montar(respostas: Array<string | Error>) {
  const { c, chamadas } = cliente(respostas);
  const logs: Array<Record<string, unknown>> = [];
  const pausas: number[] = [];
  const t = transcritorOpenAI(c, "whisper-1", (e) => logs.push(e), async (ms) => void pausas.push(ms));
  return { t, chamadas, logs, pausas };
}

describe("transcritorOpenAI", () => {
  it("chama o whisper-1 em português, com o prompt da loja e o arquivo com a extensão do mime", async () => {
    const { t, chamadas } = montar(["quero cinquenta canecas"]);
    expect(await t.transcrever(OGG, "audio/ogg; codecs=opus")).toBe("quero cinquenta canecas");
    expect(chamadas[0]).toMatchObject({ model: "whisper-1", language: "pt", response_format: "text", prompt: PROMPT_TRANSCRICAO });
    expect((chamadas[0].file as File).name).toBe("audio.ogg");
  });

  it("texto vazio ou só pontuação vira null", async () => {
    expect(await montar(["   "]).t.transcrever(OGG, "audio/ogg")).toBeNull();
    expect(await montar([" ... "]).t.transcrever(OGG, "audio/ogg")).toBeNull();
  });

  it.each([
    "Legendas pela comunidade Amara.org",
    "Obrigado por assistir!",
    "obrigada por assistir.",
    "Inscreva-se no canal",
    "Legenda Adriana Zanotto",
  ])("alucinação do Whisper em áudio mudo vira null: %s", async (frase) => {
    expect(await montar([frase]).t.transcrever(OGG, "audio/ogg")).toBeNull();
  });

  it("frase real com 'obrigado' passa (a comparação é do texto inteiro)", async () => {
    expect(await montar(["Obrigado, quero 20 squeezes"]).t.transcrever(OGG, "audio/ogg")).toBe("Obrigado, quero 20 squeezes");
  });

  it("3 falhas viram null, sem 4ª chamada, com pausas de 1 s e 3 s e log sem o texto", async () => {
    const { t, chamadas, logs, pausas } = montar([new Error("timeout 1"), new Error("timeout 2"), new Error("timeout 3"), "nunca"]);
    expect(await t.transcrever(OGG, "audio/ogg")).toBeNull();
    expect(chamadas).toHaveLength(3);
    expect(pausas).toEqual([1_000, 3_000]);
    expect(logs.map((l) => [l.type, l.tentativa])).toEqual([
      ["audio_tentativa_falhou", 1],
      ["audio_tentativa_falhou", 2],
      ["audio_tentativa_falhou", 3],
    ]);
    expect(JSON.stringify(logs)).not.toContain("nunca");
  });

  it("falha e depois acerta: devolve o texto da 2ª tentativa", async () => {
    const { t, chamadas } = montar([new Error("503"), "pra dia dez"]);
    expect(await t.transcrever(OGG, "audio/ogg")).toBe("pra dia dez");
    expect(chamadas).toHaveLength(2);
  });
});
