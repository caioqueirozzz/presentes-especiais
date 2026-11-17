import { describe, expect, it } from "vitest";
import { arquivosDoForm } from "@/lib/designHttp";

describe("arquivosDoForm", () => {
  it("com mais arquivos que o máximo, fica com os mais recentes (os últimos)", async () => {
    const form = new FormData();
    for (let i = 1; i <= 12; i++) form.append("imagem", new File([`a${i}`], `f${i}.png`));
    const r = await arquivosDoForm(form, "imagem");
    expect(r.map((f) => f.nome)).toEqual(["f3.png", "f4.png", "f5.png", "f6.png", "f7.png", "f8.png", "f9.png", "f10.png", "f11.png", "f12.png"]);
  });
});
