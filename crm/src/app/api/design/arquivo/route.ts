import { jsonError } from "@/lib/access";
import { MIME, MIME_AUDIO, armazem, chaveSegura, conferirAssinatura, detectarAudio, detectarTipo } from "@/lib/arquivos";

/**
 * Arquivo do modo disco. Vale só pela assinatura com validade (D9 da spec): quem baixa o mockup
 * para mandar no WhatsApp é a ponte, sem sessão; é o mesmo modelo da URL assinada do R2.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const chave = url.searchParams.get("chave") ?? "";
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!chaveSegura(chave) || !conferirAssinatura(chave, exp, sig)) return jsonError("Link inválido ou expirado.", 403);
  let bytes: Buffer;
  try {
    bytes = await armazem().ler(chave);
  } catch {
    return jsonError("Arquivo não encontrado.", 404);
  }
  // O detector vem do prefixo da chave: um áudio com "%PDF-" no começo não vira PDF
  const ehAudio = chave.startsWith("audios/");
  const tipo = ehAudio ? null : detectarTipo(bytes);
  const audio = ehAudio ? detectarAudio(bytes) : null;
  if (!tipo && !audio) return jsonError("Arquivo inválido.", 415);
  const headers: Record<string, string> = {
    "Content-Type": tipo ? MIME[tipo] : MIME_AUDIO[audio!],
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=600",
    "Accept-Ranges": "bytes",
  };
  // SVG pode carregar script: nunca inline
  if (tipo === "svg" || tipo === "pdf") headers["Content-Disposition"] = `attachment; filename="${chave.split("/").pop()}"`;
  if (tipo === "svg") headers["Content-Security-Policy"] = "sandbox";

  // O <audio> pede pedaços (Range) para avançar; sem 206 o player não pula. Malformado ou invertido: arquivo inteiro (RFC 9110)
  const faixa = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  const invertido = !!faixa?.[1] && !!faixa[2] && Number(faixa[1]) > Number(faixa[2]);
  if (faixa && (faixa[1] || faixa[2]) && !invertido) {
    const total = bytes.length;
    const inicio = faixa[1] ? Number(faixa[1]) : Math.max(0, total - Number(faixa[2]));
    const fim = faixa[1] && faixa[2] ? Math.min(Number(faixa[2]), total - 1) : total - 1;
    if (inicio >= total || inicio > fim) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    return new Response(new Uint8Array(bytes.subarray(inicio, fim + 1)), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${inicio}-${fim}/${total}` },
    });
  }
  return new Response(new Uint8Array(bytes), { headers });
}
