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
  ["legendas pela comunidade amara.org", "legendas pela amara.org", "obrigado por assistir", "obrigada por assistir", "inscreva-se no canal", "legenda adriana zanotto"].map(normalizar)
);

// Heurística do próprio Whisper: trecho com no_speech_prob acima disto provavelmente não tem fala
const SEM_FALA = 0.6;
const ECO = 6;
const palavrasDoPrompt = normalizar(PROMPT_TRANSCRICAO).split(" ");
// Toda sequência de 6 palavras seguidas do prompt: o eco repete o prompt em ordem; um pedido não
const TRECHOS_DO_PROMPT = new Set(palavrasDoPrompt.slice(0, -ECO + 1).map((_, i) => palavrasDoPrompt.slice(i, i + ECO).join(" ")));

/** Áudio só com barulho ou silêncio: o Whisper inventa frase ou ecoa o prompt (fumaça de 18/11). */
function semFala(texto: string, segmentos: unknown): boolean {
  const n = normalizar(texto);
  if (!n || ALUCINACOES.has(n)) return true;
  const palavras = n.split(" ");
  for (let i = 0; i + ECO <= palavras.length; i++) if (TRECHOS_DO_PROMPT.has(palavras.slice(i, i + ECO).join(" "))) return true;
  const probs = Array.isArray(segmentos) ? segmentos.map((s) => (s as { no_speech_prob?: unknown })?.no_speech_prob) : [];
  return probs.length > 0 && probs.every((p) => typeof p === "number" && p > SEM_FALA);
}

function extensao(mime: string): string {
  if (/mpeg|mp3/.test(mime)) return "mp3";
  if (/mp4|m4a|aac/.test(mime)) return "m4a";
  if (/wav/.test(mime)) return "wav";
  if (/webm/.test(mime)) return "webm";
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
          // verbose_json traz o no_speech_prob de cada trecho, que separa fala de barulho
          const r = await cliente.audio.transcriptions.create({ file, model: modelo, language: "pt", response_format: "verbose_json", prompt: PROMPT_TRANSCRICAO });
          const texto = (typeof r === "string" ? r : String((r as { text?: unknown })?.text ?? "")).trim();
          return semFala(texto, (r as { segments?: unknown })?.segments) ? null : texto;
        } catch (err) {
          log({ type: "audio_tentativa_falhou", tentativa, erro: err instanceof Error ? err.message : String(err) });
          // 400, 401 e 413 não melhoram repetindo; rede, 429 e 5xx sim
          const status = (err as { status?: unknown })?.status;
          if (typeof status === "number" && status !== 429 && status < 500) return null;
          if (tentativa < TENTATIVAS) await pausa(PAUSAS_MS[tentativa - 1]);
        }
      }
      return null;
    },
  };
}
