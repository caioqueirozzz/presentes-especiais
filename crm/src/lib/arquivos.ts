import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/*
 * Armazém dos arquivos do Módulo Design. R2 quando R2_BUCKET está definido; senão disco em
 * crm/data/arquivos. A chave é sempre montada pelo servidor (design/<job>/<tipo>-<uuid>.<ext>).
 */

export type TipoArquivo = "png" | "jpeg" | "webp" | "pdf" | "svg";
export const LIMITE_BYTES = 16 * 1024 * 1024;
export const MIME: Record<TipoArquivo, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
  svg: "image/svg+xml",
};
export const EXTENSAO: Record<TipoArquivo, string> = { png: "png", jpeg: "jpg", webp: "webp", pdf: "pdf", svg: "svg" };

/** Tipo pelos primeiros bytes: extensão e Content-Type mentem. */
export function detectarTipo(bytes: Uint8Array): TipoArquivo | null {
  const at = (i: number, ...x: number[]) => x.every((v, k) => bytes[i + k] === v);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  const inicio = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^﻿/, "");
  // Alguns geradores põem bytes antes do cabeçalho do PDF; o leitor aceita %PDF no primeiro KB
  if (inicio.slice(0, 1024).includes("%PDF-")) return "pdf";
  // SVG exportado por Illustrator/Inkscape/Corel: declaração XML, comentários e DOCTYPE antes do <svg>
  const semProlog = inicio.replace(/^(\s+|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)+/i, "");
  return semProlog.startsWith("<svg") ? "svg" : null;
}

export const ehAnalisavel = (t: TipoArquivo) => t === "png" || t === "jpeg" || t === "webp";

export type TipoAudio = "ogg" | "mp3" | "m4a" | "wav" | "webm";
export const MIME_AUDIO: Record<TipoAudio, string> = { ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", webm: "audio/webm" };

/** Áudio pelos primeiros bytes. Fora do detectarTipo para o design não aceitar nota de voz como referência. */
export function detectarAudio(bytes: Uint8Array): TipoAudio | null {
  const ascii = (i: number, s: string) => [...s].every((c, k) => bytes[i + k] === c.charCodeAt(0));
  if (ascii(0, "OggS")) return "ogg"; // o ptt do WhatsApp (Opus)
  if (ascii(4, "ftyp")) return "m4a";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "wav";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  if (ascii(0, "ID3") || (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)) return "mp3";
  return null;
}
export const chaveSegura = (chave: string) =>
  (chave.startsWith("design/") || chave.startsWith("audios/")) && !chave.includes("..") && !chave.includes("\\");

function segredo(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET não configurado.");
  return s;
}

export function assinar(chave: string, exp: number): string {
  return createHmac("sha256", segredo()).update(`${chave}.${exp}`).digest("base64url");
}

export function conferirAssinatura(chave: string, exp: number, sig: string, agora = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < agora) return false;
  const a = Buffer.from(assinar(chave, exp));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Armazem {
  salvar(chave: string, bytes: Buffer, mime: string): Promise<void>;
  ler(chave: string): Promise<Buffer>;
  /** Padrão 600 s. No disco devolve caminho relativo do CRM (use urlAbsoluta para a ponte). */
  urlTemporaria(chave: string, segundos?: number): Promise<string>;
}

function exigirChave(chave: string): void {
  if (!chaveSegura(chave)) throw new Error("Chave de arquivo inválida.");
}

function disco(): Armazem {
  const raiz = process.env.ARQUIVOS_DIR || join(process.cwd(), "data", "arquivos");
  return {
    async salvar(chave, bytes) {
      exigirChave(chave);
      await mkdir(dirname(join(raiz, chave)), { recursive: true });
      await writeFile(join(raiz, chave), bytes);
    },
    async ler(chave) {
      exigirChave(chave);
      return readFile(join(raiz, chave));
    },
    async urlTemporaria(chave, segundos = 600) {
      exigirChave(chave);
      const exp = Math.floor(Date.now() / 1000) + segundos;
      return `/api/design/arquivo?chave=${encodeURIComponent(chave)}&exp=${exp}&sig=${assinar(chave, exp)}`;
    },
  };
}

async function r2(): Promise<Armazem> {
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "" },
  });
  const Bucket = process.env.R2_BUCKET!;
  return {
    async salvar(chave, bytes, mime) {
      exigirChave(chave);
      await s3.send(new PutObjectCommand({ Bucket, Key: chave, Body: bytes, ContentType: mime }));
    },
    async ler(chave) {
      exigirChave(chave);
      const r = await s3.send(new GetObjectCommand({ Bucket, Key: chave }));
      return Buffer.from(await r.Body!.transformToByteArray());
    },
    async urlTemporaria(chave, segundos = 600) {
      exigirChave(chave);
      return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: chave }), { expiresIn: segundos });
    },
  };
}

// shortcut: o R2 não tem teste nem ensaio (sem credenciais até o Dudu responder); ensaiar quando a chave chegar
export function armazem(): Armazem {
  if (!process.env.R2_BUCKET) return disco();
  const pronto = r2();
  return {
    salvar: async (...a) => (await pronto).salvar(...a),
    ler: async (...a) => (await pronto).ler(...a),
    urlTemporaria: async (...a) => (await pronto).urlTemporaria(...a),
  };
}

/** A ponte baixa o arquivo sozinha: no modo disco, o caminho relativo vira endereço local do CRM. */
export const urlAbsoluta = (url: string) => (url.startsWith("/") ? `http://127.0.0.1:${process.env.PORT || 3200}${url}` : url);
