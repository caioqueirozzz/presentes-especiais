import { beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { criarLead, criarUsuario, limparBanco } from "./banco";

describe("banco de teste", () => {
  beforeEach(limparBanco);
  it("cria usuário e lead", async () => {
    const u = await criarUsuario({ role: "COLABORADOR" });
    const l = await criarLead({ assignedTo: u });
    const [row] = await query<{ assigned_to: string }>("SELECT assigned_to FROM leads WHERE id = $1", [l]);
    expect(row.assigned_to).toBe(u);
  });
});
