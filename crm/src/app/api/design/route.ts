import { NextResponse } from "next/server";
import { jsonError, requireUser, serverError } from "@/lib/access";
import { listarJobs } from "@/lib/design";

/** Jobs do quadro de design: o designer vê os dele; o admin, todos. */
export async function GET() {
  const guard = await requireUser({ allowDesigner: true });
  if (guard.error) return guard.error;
  if (guard.user.role !== "ADMIN" && guard.user.role !== "DESIGNER") return jsonError("Acesso restrito.", 403);
  try {
    return NextResponse.json({ jobs: await listarJobs(guard.user) });
  } catch (err) {
    return serverError(err, "listar jobs de design");
  }
}
