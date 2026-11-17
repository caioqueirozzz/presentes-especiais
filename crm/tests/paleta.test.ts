import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { calcularPaleta, pantoneMaisProximo, rgbParaLab } from "@/lib/designIa/paleta";

async function duasCores(): Promise<Buffer> {
  const w = 100, h = 100, px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const azul = i % w < 70; // 70% azul-marinho, 30% amarelo
    px.set(azul ? [0x0a, 0x2a, 0x66] : [0xff, 0xcc, 0x00], i * 3);
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// Camisa de catálogo: fundo branco em volta, corpo azul-marinho e um logo amarelo no peito
async function camisaNoFundoBranco(): Promise<Buffer> {
  const w = 100, h = 100, px = Buffer.alloc(w * h * 3, 0xff);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const camisa = x >= 20 && x < 80 && y >= 15 && y < 95;
      const logo = x >= 50 && x < 70 && y >= 30 && y < 50;
      if (camisa) px.set(logo ? [0xff, 0xcc, 0x00] : [0x0a, 0x2a, 0x66], (y * w + x) * 3);
    }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe("paleta", () => {
  it("descarta o fundo que ocupa a borda da foto e calcula a participação sobre a peça", async () => {
    const p = await calcularPaleta(await camisaNoFundoBranco());
    expect(p.map((c) => c.hex)).toEqual(["#0A2A66", "#FFCC00"]);
    expect(p[0].participacao).toBeCloseTo(0.92, 1);
  });
  it("imagem com 2 cores devolve essas 2, ordenadas por participação", async () => {
    const p = await calcularPaleta(await duasCores());
    expect(p).toHaveLength(2);
    expect(p[0].hex).toBe("#0A2A66");
    expect(p[1].hex).toBe("#FFCC00");
    expect(p[0].participacao).toBeCloseTo(0.7, 1);
  });
  it("é determinística", async () => {
    const img = await duasCores();
    expect(await calcularPaleta(img)).toEqual(await calcularPaleta(img));
  });
  it("Lab do branco e Pantone mais próximo", () => {
    const [L] = rgbParaLab(255, 255, 255);
    expect(L).toBeCloseTo(100, 0);
    expect(pantoneMaisProximo("#00205C", [{ codigo: "281 C", hex: "#00205B" }, { codigo: "Yellow C", hex: "#FEDD00" }])).toBe("281 C");
  });
});
