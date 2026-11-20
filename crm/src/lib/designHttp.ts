import { NextResponse } from "next/server";
import { jsonError, requireUser, serverError } from "@/lib/access";
import type { SessionUser } from "@/lib/auth/session";
import { DesignError, jobDoUsuario } from "@/lib/design";
import type { Etapa } from "@/lib/design";

/*
 * Guarda das rotas /api/design/*: só ADMIN e DESIGNER, e o designer só no job dele.
 * A conferência é aqui, no servidor, não só na tela.
 */

type JobVisivel = { id: string; lead_id: string; designer_id: string | null; stage: Etapa };
type Guarda = { user: SessionUser; job: JobVisivel; error?: never } | { user?: never; job?: never; error: NextResponse };

export async function guardaDoJob(id: string, opcoes: { escrita?: boolean } = {}): Promise<Guarda> {
  const guard = await requireUser({ allowDesigner: true });
  if (guard.error) return { error: guard.error };
  const user = guard.user;
  if (user.role !== "ADMIN" && user.role !== "DESIGNER") return { error: jsonError("Acesso restrito.", 403) };
  const job = await jobDoUsuario(id, user);
  if (!job) return { error: jsonError("Job não encontrado.", 404) };
  // Sem designer, o designer só pode ver e assumir; mexer é do atribuído ou do admin
  if (opcoes.escrita && user.role !== "ADMIN" && job.designer_id !== user.id) return { error: jsonError("Assuma o job antes.", 403) };
  return { user, job };
}

export function erroDeDesign(err: unknown, contexto: string) {
  if (err instanceof DesignError) return jsonError(err.message, err.status);
  return serverError(err, contexto);
}

/** Arquivos de um multipart, como o design.ts recebe. */
export async function arquivosDoForm(form: FormData, campo: string, max = 10): Promise<{ bytes: Buffer; nome: string }[]> {
  // A ponte manda os arquivos da conversa do mais antigo ao mais recente: passando do limite, ficam os últimos
  const files = form
    .getAll(campo)
    .filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f)
    .slice(-max);
  return Promise.all(files.map(async (f) => ({ bytes: Buffer.from(await f.arrayBuffer()), nome: (f.name || "arquivo").slice(0, 120) })));
}
