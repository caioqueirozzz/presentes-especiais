import { NextResponse } from "next/server";
import { detalharJob } from "@/lib/design";
import { erroDeDesign, guardaDoJob } from "@/lib/designHttp";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  try {
    const g = await guardaDoJob(id);
    if (g.error) return g.error;
    return NextResponse.json(await detalharJob(id));
  } catch (err) {
    return erroDeDesign(err, "abrir job de design");
  }
}
