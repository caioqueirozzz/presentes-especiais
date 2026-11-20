import { toFile } from "openai";
import { esperar } from "./envio.js";
import type { LogPonte } from "./log.js";

export interface Transcritor {
  /** Texto do áudio, ou null quando não deu (falha, silêncio ou alucinação conhecida). */
  transcrever(dados: Buffer, mime: string): Promise<string | null>;
}

/** O pedaço do SDK `openai` que a transcrição usa; o teste injeta um falso. */
export interface ClienteTranscricao {
  audio: { transcriptions: { create(p: Record<string, unknown>): Promise<unknown> } };
}

// O Whisper só considera os ~224 tokens finais do prompt: curto e com o vocabulário da loja
export const PROMPT_TRANSCRICAO =
  "Mensagem de voz em português do Brasil de um cliente da Presentes Especiais, loja de brindes personalizados. " +
  "Produtos comuns: camisa dry fit, caneca mágica, squeeze, garrafa térmica, ecobag, boné, caneta, chaveiro, agenda. " +
  "O cliente fala quantidades (cinquenta unidades), cores, prazos e a logo da empresa.";

const TENTATIVAS = 3;
const PAUSAS_MS = [1_000, 3_000];

const normalizar = (t: string) =>
  t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

// O Whisper inventa estas frases em áudio sem fala; compara o texto inteiro, nunca includes
const ALUCINACOES = new Set(
  ["legendas pela comunidade amara.org", "obrigado por assistir", "obrigada por assistir", "inscreva-se no canal", "legenda adriana zanotto"].map(normalizar)
);

function extensao(mime: string): string {
  if (/mpeg|mp3/.test(mime)) return "mp3";
  if (/mp4|m4a|aac/.test(mime)) return "m4a";
  return "ogg"; // o ptt do WhatsApp é Opus em Ogg
}

export function transcritorOpenAI(
  cliente: ClienteTranscricao,
  modelo: string,
  log: LogPonte,
  pausa: (ms: number) => Promise<void> = esperar
): Transcritor {
  return {
    async transcrever(dados, mime) {
      for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
        try {
          const file = await toFile(dados, `audio.${extensao(mime)}`, { type: mime.split(";")[0].trim() });
          const r = await cliente.audio.transcriptions.create({ file, model: modelo, language: "pt", response_format: "text", prompt: PROMPT_TRANSCRICAO });
          const texto = (typeof r === "string" ? r : String((r as { text?: unknown })?.text ?? "")).trim();
          const n = normalizar(texto);
          return n && !ALUCINACOES.has(n) ? texto : null;
        } catch (err) {
          log({ type: "audio_tentativa_falhou", tentativa, erro: err instanceof Error ? err.message : String(err) });
          if (tentativa < TENTATIVAS) await pausa(PAUSAS_MS[tentativa - 1]);
        }
      }
      return null;
    },
  };
}
