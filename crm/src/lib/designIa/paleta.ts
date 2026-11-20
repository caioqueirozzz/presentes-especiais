import sharp from "sharp";
import tabelaPadrao from "./pantone.json";

export type CorPaleta = { hex: string; pantone_aprox: string | null; participacao: number };
type RGB = [number, number, number];

const hex = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const deHex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;

export function rgbParaLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function pantoneMaisProximo(h: string, tabela: Array<{ codigo: string; hex: string }> = tabelaPadrao): string | null {
  const alvo = rgbParaLab(...deHex(h));
  let melhor: string | null = null;
  let menor = Infinity;
  for (const p of tabela) {
    const l = rgbParaLab(...deHex(p.hex));
    const d = Math.hypot(alvo[0] - l[0], alvo[1] - l[1], alvo[2] - l[2]); // ΔE CIE76
    if (d < menor) {
      menor = d;
      melhor = p.codigo;
    }
  }
  return melhor;
}

const dist2 = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
 * Foto de catálogo tem fundo liso em volta da peça. Se uma cor ocupa ao menos 80% da borda, ela é o fundo
 * e sai da conta, com os pixels parecidos com ela. Sem fundo claro (ou se quase nada sobrar), nada sai.
 */
function semFundo(px: RGB[], lado: number): RGB[] {
  const borda = px.filter((_, i) => i < lado || i >= px.length - lado || i % lado === 0 || i % lado === lado - 1);
  const grupos = new Map<string, RGB[]>();
  for (const p of borda) {
    const k = p.map((c) => c >> 4).join(",");
    grupos.set(k, [...(grupos.get(k) ?? []), p]);
  }
  const maior = [...grupos.values()].sort((a, b) => b.length - a.length)[0];
  if (maior.length < 0.8 * borda.length) return px;
  const fundo = [0, 1, 2].map((ch) => maior.reduce((s, p) => s + p[ch], 0) / maior.length) as RGB;
  const resto = px.filter((p) => dist2(p, fundo) > 40 ** 2);
  return resto.length >= 0.1 * px.length ? resto : px;
}

/** Cores dominantes por k-means (k=6) numa miniatura 64×64; grupos com menos de 3% saem. Transparência vira branco. */
export async function calcularPaleta(imagem: Buffer): Promise<CorPaleta[]> {
  const raw = await sharp(imagem).flatten({ background: "#ffffff" }).resize(64, 64, { fit: "fill", kernel: "nearest" }).raw().toBuffer();
  const todos: RGB[] = [];
  for (let i = 0; i < raw.length; i += 3) todos.push([raw[i], raw[i + 1], raw[i + 2]]);
  const px = semFundo(todos, 64);
  const k = 6;
  let centros: RGB[] = Array.from({ length: k }, (_, i) => px[Math.floor((i * px.length) / k)]); // sementes fixas: resultado determinístico
  let grupo = new Array<number>(px.length).fill(0);
  for (let it = 0; it < 10; it++) {
    grupo = px.map((p) => {
      let m = 0;
      let dm = Infinity;
      centros.forEach((c, j) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < dm) {
          dm = d;
          m = j;
        }
      });
      return m;
    });
    centros = centros.map((c, j) => {
      const membros = px.filter((_, i) => grupo[i] === j);
      if (!membros.length) return c;
      return [0, 1, 2].map((ch) => membros.reduce((s, p) => s + p[ch], 0) / membros.length) as RGB;
    });
  }
  const contagem = centros.map((_, j) => grupo.filter((g) => g === j).length);
  const vistos = new Map<string, number>();
  centros.forEach((c, j) => {
    const h = hex(c);
    vistos.set(h, (vistos.get(h) ?? 0) + contagem[j]); // sementes iguais viram um grupo só
  });
  return [...vistos.entries()]
    .map(([h, n]) => ({ hex: h, participacao: n / px.length }))
    .filter((c) => c.participacao >= 0.03)
    .sort((a, b) => b.participacao - a.participacao)
    .map((c) => ({ ...c, participacao: Math.round(c.participacao * 100) / 100, pantone_aprox: pantoneMaisProximo(c.hex) }));
}
