import { beforeEach, expect, it } from "vitest";
import { query } from "@/lib/db";
import { barraDesigner, leadScope } from "@/lib/access";
import type { SessionUser } from "@/lib/auth/session";
import { abrirOuAnexar } from "@/lib/design";
import { criarLead, criarUsuario, limparBanco } from "./banco";

beforeEach(limparBanco);

it("designer é barrado por padrão e liberado onde a rota pede", () => {
  expect(barraDesigner({ role: "DESIGNER" })).toBe(true);
  expect(barraDesigner({ role: "DESIGNER" }, true)).toBe(false);
  expect(barraDesigner({ role: "COLABORADOR" })).toBe(false);
  expect(barraDesigner({ role: "ADMIN" })).toBe(false);
});

it("leadScope do designer: vê o lead do job dele, não vê outro", async () => {
  const d = await criarUsuario({ role: "DESIGNER" });
  const meu = await criarLead();
  const outro = await criarLead();
  await abrirOuAnexar({ leadId: meu, origem: "VENDEDOR", imagens: [] });
  const params: unknown[] = [];
  const scope = leadScope({ id: d, role: "DESIGNER" } as SessionUser, params);
  const rows = await query<{ id: string }>(`SELECT l.id FROM leads l WHERE ${scope}`, params);
  expect(rows.map((r) => r.id)).toEqual([meu]);
  expect(rows.map((r) => r.id)).not.toContain(outro);
});
