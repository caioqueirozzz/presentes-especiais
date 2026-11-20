import { jsonError } from "@/lib/access";
import { MIME, armazem, chaveSegura, conferirAssinatura, detectarTipo } from "@/lib/arquivos";

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
  const tipo = detectarTipo(bytes);
  if (!tipo) return jsonError("Arquivo inválido.", 415);
  const headers: Record<string, string> = {
    "Content-Type": MIME[tipo],
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=600",
  };
  // SVG pode carregar script: nunca inline
  if (tipo === "svg" || tipo === "pdf") headers["Content-Disposition"] = `attachment; filename="${chave.split("/").pop()}"`;
  if (tipo === "svg") headers["Content-Security-Policy"] = "sandbox";
  return new Response(new Uint8Array(bytes), { headers });
}
