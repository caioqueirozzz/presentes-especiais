import { beforeEach, describe, expect, it, vi } from "vitest";
import { one, query } from "@/lib/db";
import { signSession } from "@/lib/auth/token";
import { abrirOuAnexar } from "@/lib/design";
import { PATCH } from "@/app/api/team/[id]/route";
import { criarLead, criarUsuario, limparBanco } from "./banco";

let token = "";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: token }) }) }));

async function entrarComoAdmin(): Promise<void> {
  const id = await criarUsuario({ role: "ADMIN" });
  await query("UPDATE users SET must_change_password = false WHERE id = $1", [id]);
  const { v } = (await one<{ v: number }>("SELECT session_version AS v FROM users WHERE id = $1", [id]))!;
  token = await signSession({ sub: id, role: "ADMIN", v });
}

const editar = (id: string, corpo: object) =>
  PATCH(new Request(`http://crm.local/api/team/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) }), {
    params: Promise.resolve({ id }),
  });

async function jobDoDesigner(designer: string): Promise<string> {
  const { jobId } = await abrirOuAnexar({ leadId: await criarLead(), origem: "VENDEDOR", imagens: [] });
  await query("UPDATE design_jobs SET designer_id = $2 WHERE id = $1", [jobId, designer]);
  return jobId;
}
const donoDoJob = async (jobId: string) => (await one<{ d: string | null }>("SELECT designer_id AS d FROM design_jobs WHERE id = $1", [jobId]))!.d;

describe("equipe: quem sai ou muda de papel", () => {
  beforeEach(limparBanco);

  it("designer desativado: os jobs abertos dele ficam sem dono", async () => {
    await entrarComoAdmin();
    const d = await criarUsuario({ role: "DESIGNER" });
    const jobId = await jobDoDesigner(d);
    expect((await editar(d, { is_active: false })).status).toBe(200);
    expect(await donoDoJob(jobId)).toBeNull();
  });

  it("designer que vira colaborador: os jobs abertos dele ficam sem dono", async () => {
    await entrarComoAdmin();
    const d = await criarUsuario({ role: "DESIGNER" });
    const jobId = await jobDoDesigner(d);
    expect((await editar(d, { role: "COLABORADOR" })).status).toBe(200);
    expect(await donoDoJob(jobId)).toBeNull();
  });

  it("colaborador que vira designer devolve os leads abertos à fila", async () => {
    await entrarComoAdmin();
    const c = await criarUsuario({ role: "COLABORADOR" });
    const lead = await criarLead({ assignedTo: c });
    expect((await editar(c, { role: "DESIGNER" })).status).toBe(200);
    expect((await one<{ a: string | null }>("SELECT assigned_to AS a FROM leads WHERE id = $1", [lead]))!.a).toBeNull();
  });
});
