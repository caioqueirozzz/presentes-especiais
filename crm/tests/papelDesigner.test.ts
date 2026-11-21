import { beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { homeFor, signSession, verifySession } from "@/lib/auth/token";
import { criarUsuario, limparBanco } from "./banco";

describe("papel DESIGNER", () => {
  beforeEach(limparBanco);
  it("o banco aceita o papel e as tabelas de design existem", async () => {
    expect(await criarUsuario({ role: "DESIGNER" })).toBeTruthy();
    const [t] = await query<{ n: number }>("SELECT COUNT(*)::int AS n FROM design_jobs");
    expect(t.n).toBe(0);
  });
  it("o token aceita DESIGNER e a casa dele é o quadro", async () => {
    const token = await signSession({ sub: "00000000-0000-0000-0000-000000000001", role: "DESIGNER", v: 0 });
    expect((await verifySession(token))?.role).toBe("DESIGNER");
    expect(homeFor("DESIGNER")).toBe("/app/design");
    expect(homeFor("COLABORADOR")).toBe("/app/inicio");
  });
});
