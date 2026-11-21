import { describe, expect, it } from "vitest";
import { PROMPT_TRANSCRICAO, transcritorOpenAI, type ClienteTranscricao } from "../src/whatsapp/transcricao.js";

const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]);

function cliente(respostas: Array<string | Error | object>) {
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

function montar(respostas: Array<string | Error | object>) {
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
    expect(chamadas[0]).toMatchObject({ model: "whisper-1", language: "pt", response_format: "verbose_json", prompt: PROMPT_TRANSCRICAO });
    expect((chamadas[0].file as File).name).toBe("audio.ogg");
  });

  it("modelo gpt-4o-*-transcribe pede json, que é o que ele aceita", async () => {
    const { c, chamadas } = cliente([{ text: "quero vinte squeezes" }]);
    const t = transcritorOpenAI(c, "gpt-4o-mini-transcribe", () => {}, async () => {});
    expect(await t.transcrever(OGG, "audio/ogg")).toBe("quero vinte squeezes");
    expect(chamadas[0].response_format).toBe("json");
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
    "Legendas pela Amara.org",
  ])("alucinação do Whisper em áudio mudo vira null: %s", async (frase) => {
    expect(await montar([frase]).t.transcrever(OGG, "audio/ogg")).toBeNull();
  });

  it("todos os trechos com cara de sem fala (no_speech_prob > 0,6): null, seja qual for o texto", async () => {
    const r = { text: "Qualquer coisa inventada", segments: [{ no_speech_prob: 0.92 }, { no_speech_prob: 0.71 }] };
    expect(await montar([r]).t.transcrever(OGG, "audio/ogg")).toBeNull();
  });

  it("basta um trecho com fala para o texto passar", async () => {
    const r = { text: "quero vinte squeezes", segments: [{ no_speech_prob: 0.9 }, { no_speech_prob: 0.05 }] };
    expect(await montar([r]).t.transcrever(OGG, "audio/ogg")).toBe("quero vinte squeezes");
  });

  it("eco do próprio prompt (áudio só com barulho, fumaça de 18/11): null", async () => {
    const eco = "A mensagem de voz em português do Brasil de um cliente da Presentes Especiais, loja de brindes personalizados.";
    expect(await montar([{ text: eco, segments: [{ no_speech_prob: 0.2 }] }]).t.transcrever(OGG, "audio/ogg")).toBeNull();
  });

  it.each(["Caneca mágica", "Quero caneca mágica e garrafa térmica com a logo da empresa", "Quero 50 camisas dry fit com a logo da empresa"])(
    "pedido com palavras do prompt passa: %s",
    async (frase) => {
      expect(await montar([frase]).t.transcrever(OGG, "audio/ogg")).toBe(frase);
    }
  );

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

  it("erro que não melhora repetindo (400, 401, 413): para na 1ª tentativa, sem pausa", async () => {
    for (const status of [400, 401, 413]) {
      const { t, chamadas, pausas } = montar([Object.assign(new Error(`http ${status}`), { status }), "nunca"]);
      expect(await t.transcrever(OGG, "audio/ogg")).toBeNull();
      expect(chamadas).toHaveLength(1);
      expect(pausas).toEqual([]);
    }
  });

  it("429 e 5xx repetem", async () => {
    const { t, chamadas } = montar([Object.assign(new Error("lento"), { status: 429 }), Object.assign(new Error("fora"), { status: 503 }), "ok"]);
    expect(await t.transcrever(OGG, "audio/ogg")).toBe("ok");
    expect(chamadas).toHaveLength(3);
  });

  it.each([
    ["audio/wav", "audio.wav"],
    ["audio/webm", "audio.webm"],
    ["audio/mpeg", "audio.mp3"],
    ["audio/mp4", "audio.m4a"],
  ])("arquivo nomeado pelo mime: %s vira %s", async (mime, nome) => {
    const { t, chamadas } = montar(["oi"]);
    await t.transcrever(OGG, mime);
    expect((chamadas[0].file as File).name).toBe(nome);
  });

  it("falha e depois acerta: devolve o texto da 2ª tentativa", async () => {
    const { t, chamadas } = montar([new Error("503"), "pra dia dez"]);
    expect(await t.transcrever(OGG, "audio/ogg")).toBe("pra dia dez");
    expect(chamadas).toHaveLength(2);
  });
});
