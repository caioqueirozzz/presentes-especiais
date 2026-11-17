import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { armazem, assinar, conferirAssinatura, detectarTipo } from "@/lib/arquivos";

const b = (...x: number[]) => Uint8Array.from(x);
const txt = (s: string) => new TextEncoder().encode(s);

describe("detectarTipo", () => {
  it("reconhece cada tipo pelos primeiros bytes", () => {
    expect(detectarTipo(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe("png");
    expect(detectarTipo(b(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
    expect(detectarTipo(txt("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(detectarTipo(txt("%PDF-1.7"))).toBe("pdf");
    expect(detectarTipo(txt("  <svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe("svg");
    expect(detectarTipo(txt('<?xml version="1.0"?>\n<svg/>'))).toBe("svg");
  });
  it("recusa vazio, extensão mentirosa e texto qualquer", () => {
    expect(detectarTipo(b())).toBeNull();
    expect(detectarTipo(txt("MZ\x90\0"))).toBeNull();
    expect(detectarTipo(txt("<html><svg/></html>"))).toBeNull();
    expect(detectarTipo(txt("RIFF\0\0\0\0WAVE"))).toBeNull();
  });
});

describe("assinatura do modo disco", () => {
  it("vale até expirar e não aceita adulteração", () => {
    const exp = 2_000_000_000;
    const sig = assinar("design/a/b.png", exp);
    expect(conferirAssinatura("design/a/b.png", exp, sig, exp * 1000 - 1)).toBe(true);
    expect(conferirAssinatura("design/a/b.png", exp, sig, exp * 1000 + 1)).toBe(false);
    expect(conferirAssinatura("design/a/c.png", exp, sig, 0)).toBe(false);
    expect(conferirAssinatura("design/a/b.png", exp + 1, sig, 0)).toBe(false);
  });
});

describe("armazém em disco", () => {
  beforeAll(() => {
    process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "arq-"));
    delete process.env.R2_BUCKET;
  });
  it("salva e lê", async () => {
    await armazem().salvar("design/j1/original-1.png", Buffer.from("abc"), "image/png");
    expect((await armazem().ler("design/j1/original-1.png")).toString()).toBe("abc");
  });
  it("recusa chave com .. ou barra invertida", async () => {
    await expect(armazem().salvar("design/../x.png", Buffer.from("a"), "image/png")).rejects.toThrow();
    await expect(armazem().ler(`design${String.fromCharCode(92)}x.png`)).rejects.toThrow();
  });
  it("url temporária aponta para a rota assinada", async () => {
    const url = await armazem().urlTemporaria("design/j1/original-1.png");
    expect(url).toMatch(/^\/api\/design\/arquivo\?chave=design%2Fj1%2Foriginal-1\.png&exp=\d+&sig=/);
  });
});
