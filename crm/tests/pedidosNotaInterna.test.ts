import { beforeEach, describe, expect, it, vi } from "vitest";
import { one, query } from "@/lib/db";
import { signSession } from "@/lib/auth/token";
import { GET as listar } from "@/app/api/orders/route";
import { GET as abrir } from "@/app/api/orders/[id]/route";
import { criarLead, criarUsuario, limparBanco } from "./banco";

let token = "";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: token }) }) }));

async function entrarComo(role: "ADMIN" | "COLABORADOR"): Promise<string> {
  const id = await criarUsuario({ role });
  await query("UPDATE users SET must_change_password = false WHERE id = $1", [id]);
  const { v } = (await one<{ v: number }>("SELECT session_version AS v FROM users WHERE id = $1", [id]))!;
  token = await signSession({ sub: id, role, v });
  return id;
}

async function pedidoComNota(vendedor: string): Promise<{ leadId: string; pedidoId: string }> {
  const leadId = await criarLead({ assignedTo: vendedor });
  const [p] = await query<{ id: string }>(
    "INSERT INTO orders (lead_id, phone, title, stage, code, internal_note) VALUES ($1, '5511900000077', 'x', 'ARTE', 'P-N1', 'nota da gestão') RETURNING id",
    [leadId]
  );
  return { leadId, pedidoId: p.id };
}

describe("observação interna do pedido", () => {
  beforeEach(limparBanco);

  it("o colaborador não recebe a nota na lista nem no filtro por lead", async () => {
    const eu = await entrarComo("COLABORADOR");
    const { leadId } = await pedidoComNota(eu);
    for (const url of ["http://x/api/orders", `http://x/api/orders?lead=${leadId}`]) {
      const { orders } = await (await listar(new Request(url))).json();
      expect(orders).toHaveLength(1);
      expect(orders[0].internal_note).toBeNull();
    }
  });

  it("o colaborador não recebe a nota no detalhe", async () => {
    const eu = await entrarComo("COLABORADOR");
    const { pedidoId } = await pedidoComNota(eu);
    const { order } = await (await abrir(new Request("http://x"), { params: Promise.resolve({ id: pedidoId }) })).json();
    expect(order.internal_note).toBeNull();
  });

  it("o admin recebe a nota", async () => {
    const vendedor = await criarUsuario({ role: "COLABORADOR" });
    await entrarComo("ADMIN");
    await pedidoComNota(vendedor);
    const r = await listar(new Request("http://x/api/orders"));
    const { orders } = await r.json();
    expect(r.status).toBe(200);
    expect(orders[0].internal_note).toBe("nota da gestão");
  });
});
