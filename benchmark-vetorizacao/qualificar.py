"""Qualificação dos elementos extraídos pelo pipeline v2 (saida-v2/).

Para cada elemento, dá uma nota de 0 a 100 a partir de três medidas:

- Fidelidade (50%): o SVG é desenhado de volta em pixels, sobre a cor de fundo do recorte, e comparado
  com o recorte original. Mede quanto da forma confere (IoU das áreas de estampa) e o erro de cor.
- Resolução de origem (30%): recortes minúsculos não têm informação, mesmo que o traço saia limpo.
- Limpeza (20%): caminhos por cor. Muitos caminhos por cor = ruído, sujeira de compressão, letras quebradas.

Classes: A (>= 75, pronto para uso), B (55-74, precisa de retoque), C (< 55, refazer ou redesenhar).
Elementos com o mesmo texto em imagens diferentes formam um grupo; o de maior nota é a "melhor versão".

Não instala nada: os SVGs do vtracer só usam M, C e Z com translate, e são desenhados com o PIL.

Uso: .venv/bin/python -I qualificar.py
"""

from __future__ import annotations

import html
import json
import math
import re
import unicodedata
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw

RAIZ = Path(__file__).resolve().parent
SAIDA = RAIZ / "saida-v2"
SUPER = 2  # desenha o SVG com 2x de amostragem para suavizar as bordas


# ---------- rasterização mínima do SVG do vtracer ----------

def _bezier(p0, p1, p2, p3, passos=8):
    for i in range(1, passos + 1):
        t = i / passos
        u = 1 - t
        yield (u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
               u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1])


def _subcaminhos(d: str):
    toks = re.findall(r"[MCZ]|-?\d*\.?\d+(?:e-?\d+)?", d)
    atual, pts, i, cmd = None, [], 0, None
    while i < len(toks):
        t = toks[i]
        if t in "MCZ":
            cmd = t
            i += 1
            if cmd == "Z":
                if len(pts) > 2:
                    yield pts
                pts = []
            continue
        if cmd == "M":
            if len(pts) > 2:
                yield pts
            atual = (float(toks[i]), float(toks[i + 1]))
            pts = [atual]
            i += 2
            cmd = "C"  # coordenadas soltas depois de M são tratadas como continuação
        elif cmd == "C":
            c = [float(x) for x in toks[i:i + 6]]
            p1, p2, p3 = (c[0], c[1]), (c[2], c[3]), (c[4], c[5])
            pts.extend(_bezier(atual, p1, p2, p3))
            atual = p3
            i += 6
        else:
            i += 1
    if len(pts) > 2:
        yield pts


def desenhar_svg(svg: Path) -> tuple[Image.Image, list[float]]:
    """RGBA no tamanho declarado pelo SVG e a diagonal de cada caminho (relativa à diagonal da imagem)."""
    texto = svg.read_text()
    w = int(float(re.search(r'<svg[^>]*width="([\d.]+)"', texto).group(1)))
    h = int(float(re.search(r'<svg[^>]*height="([\d.]+)"', texto).group(1)))
    W, H = w * SUPER, h * SUPER
    tela = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    diagonais = []
    for m in re.finditer(r"<path\b([^>]*)/?>", texto):
        attrs = m.group(1)
        d = re.search(r'\bd="([^"]*)"', attrs).group(1)
        cor = re.search(r'fill="(#[0-9A-Fa-f]{6})"', attrs).group(1)
        tx = re.search(r'translate\(([-\d.e]+),\s*([-\d.e]+)\)', attrs)
        dx, dy = (float(tx.group(1)), float(tx.group(2))) if tx else (0.0, 0.0)
        mascara = Image.new("L", (W, H), 0)
        subs = list(_subcaminhos(d))
        todos = [q for pts in subs for q in pts]
        if todos:
            xs, ys = [q[0] for q in todos], [q[1] for q in todos]
            diagonais.append(math.hypot(max(xs) - min(xs), max(ys) - min(ys)) / math.hypot(w, h))
        for pts in subs:
            sub = Image.new("L", (W, H), 0)
            ImageDraw.Draw(sub).polygon([((x + dx) * SUPER, (y + dy) * SUPER) for x, y in pts], fill=255)
            mascara = ImageChops.logical_xor(mascara.convert("1"), sub.convert("1")).convert("L")  # furos (evenodd)
        tela.paste(Image.new("RGBA", (W, H), cor), (0, 0), mascara)
    return tela.resize((w, h), Image.LANCZOS), diagonais


# ---------- medidas ----------

def cor_de_fundo(img: np.ndarray) -> np.ndarray:
    borda = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
    return np.median(borda, axis=0)


def fidelidade(recorte: Image.Image, svg_rgba: Image.Image) -> dict:
    orig = np.asarray(recorte.convert("RGB"), dtype=np.float32)
    fundo = cor_de_fundo(orig)
    render = svg_rgba.resize(recorte.size, Image.LANCZOS)
    base = Image.new("RGBA", recorte.size, tuple(int(v) for v in fundo) + (255,))
    rec = np.asarray(Image.alpha_composite(base, render).convert("RGB"), dtype=np.float32)

    lim = 45.0  # distância de cor (0-441) para contar como estampa e não tecido
    fg_o = np.linalg.norm(orig - fundo, axis=2) > lim
    fg_r = np.linalg.norm(rec - fundo, axis=2) > lim
    uniao, inter = (fg_o | fg_r).sum(), (fg_o & fg_r).sum()
    iou = float(inter / uniao) if uniao else 0.0
    erro_cor = float(np.linalg.norm(orig - rec, axis=2)[fg_o & fg_r].mean() / 441.7) if inter else 1.0
    return {"iou": iou, "erro_cor": erro_cor, "fidelidade": max(0.0, iou * (1 - 1.5 * erro_cor))}


def nota_resolucao(w: int, h: int) -> float:
    lado = math.sqrt(w * h)  # lado equivalente de um quadrado com a mesma área
    return min(1.0, max(0.0, math.log2(lado / 40) / math.log2(300 / 40)))


def nota_limpeza(diagonais: list[float]) -> tuple[float, float]:
    """Fração de caminhos minúsculos (< 1,5% da diagonal): pingos de ruído, não letras nem formas.
    Texto tem muitos caminhos (um por letra), mas eles não são minúsculos, então não é punido."""
    if not diagonais:
        return 0.0, 1.0
    frac = sum(1 for d in diagonais if d < 0.015) / len(diagonais)
    return min(1.0, max(0.0, 1 - frac / 0.4)), frac


def chave_grupo(texto: str) -> str | None:
    if not texto:
        return None
    t = unicodedata.normalize("NFKD", texto.split(" / ")[0]).encode("ascii", "ignore").decode().lower()
    t = re.sub(r"[^a-z]", "", t)
    return t[:4] or None  # "dcte", "cto", "solu": tolera os erros de leitura do Florence


def classe(n: int) -> str:
    return "A" if n >= 75 else "B" if n >= 55 else "C"


# ---------- relatório ----------

ROTULO = {"A": "Pronto para uso", "B": "Precisa de retoque", "C": "Refazer / redesenhar"}


def pagina(itens: list[dict]) -> str:
    cont = {c: sum(1 for i in itens if i["classe"] == c) for c in "ABC"}
    cards = []
    for i in itens:
        chave = html.escape(f"v2::{i['imagem']}::{i['id']}")
        notas = "".join(f'<label><input type="radio" name="{chave}" value="{n}">{n}</label>' for n in range(1, 6))
        estrela = '<span class="melhor" title="Melhor versão deste elemento entre as imagens">★ melhor versão</span>' if i["melhor"] else ""
        cores = "".join(f'<span class="cor" style="background:{c}" title="{c}"></span>' for c in i["cores"])
        titulo = html.escape(i["texto"] or "grafismo sem texto")
        cards.append(f"""<article class="card" data-classe="{i['classe']}">
  <header><span class="nota-total c{i['classe']}">{i['nota']}</span><div><h3>{titulo}</h3>
  <p class="meta">{html.escape(i['imagem'])} · {i['id']} {estrela}</p></div></header>
  <div class="par"><figure><img src="{i['pasta']}/{i['id']}-recorte.png" alt=""><figcaption>original {i['recorte_px'][0]}×{i['recorte_px'][1]}</figcaption></figure>
  <figure class="xadrez"><img src="{i['pasta']}/{i['id']}.svg" alt=""><figcaption>SVG · <a href="{i['pasta']}/{i['id']}.svg" download>baixar</a></figcaption></figure></div>
  <dl><div><dt>Fidelidade</dt><dd><meter min="0" max="1" value="{i['fidelidade']:.2f}"></meter> {round(i['fidelidade'] * 100)}</dd></div>
  <div><dt>Resolução</dt><dd><meter min="0" max="1" value="{i['resolucao']:.2f}"></meter> {round(i['resolucao'] * 100)}</dd></div>
  <div><dt>Limpeza</dt><dd><meter min="0" max="1" value="{i['limpeza']:.2f}"></meter> {round(i['limpeza'] * 100)}</dd></div></dl>
  <p class="meta">forma confere {round(i['iou'] * 100)}% · {i['caminhos']} caminhos ({round(i['ruido'] * 100)}% ruído) em {len(i['cores'])} cores {cores}</p>
  <div class="nota" data-chave="{chave}">Sua nota: {notas}</div></article>""")
    filtros = "".join(f'<button data-f="{c}">{c} · {ROTULO[c]} ({cont[c]})</button>' for c in "ABC")
    return f"""<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Qualificação da extração</title><style>
:root {{ --fundo:#f6f6f4; --card:#fff; --texto:#1d1d1b; --sutil:#6b6b66; --linha:#e2e2dc; --acento:#c2410c;
  --a:#15803d; --b:#b45309; --c:#b91c1c; }}
@media (prefers-color-scheme: dark) {{ :root {{ --fundo:#161615; --card:#1f1f1d; --texto:#ecece8; --sutil:#a3a39c; --linha:#33332f;
  --acento:#fb923c; --a:#4ade80; --b:#fbbf24; --c:#f87171; }} }}
body {{ margin:0; padding:24px 16px; background:var(--fundo); color:var(--texto); font:15px/1.5 system-ui, sans-serif; }}
main {{ max-width:1200px; margin:0 auto; }} h1 {{ font-size:22px; margin:0 0 4px; }} h3 {{ margin:0; font-size:15px; }}
.meta {{ color:var(--sutil); font-size:13px; margin:4px 0; }}
.filtros {{ display:flex; flex-wrap:wrap; gap:8px; margin:16px 0 20px; }}
.filtros button {{ font:inherit; font-size:13px; padding:6px 12px; border-radius:999px; border:1px solid var(--linha); background:var(--card); color:var(--texto); cursor:pointer; }}
.filtros button[aria-pressed=true] {{ border-color:var(--acento); color:var(--acento); }}
.grade {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:16px; }}
.card {{ background:var(--card); border:1px solid var(--linha); border-radius:10px; padding:14px; }}
.card > header {{ display:flex; gap:12px; align-items:center; margin-bottom:10px; }}
.nota-total {{ flex:none; width:46px; height:46px; border-radius:10px; display:grid; place-items:center; font-weight:700; font-size:18px; color:#fff; }}
.cA {{ background:var(--a); }} .cB {{ background:var(--b); }} .cC {{ background:var(--c); }}
@media (prefers-color-scheme: dark) {{ .nota-total {{ color:#111; }} }}
.melhor {{ color:var(--acento); font-weight:600; margin-left:6px; }}
.par {{ display:grid; grid-template-columns:1fr 1fr; gap:8px; }} figure {{ margin:0; }}
figure img {{ width:100%; aspect-ratio:1; object-fit:contain; border-radius:6px; border:1px solid var(--linha); background:#fff; }}
.xadrez img {{ background:repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0/16px 16px; }}
figcaption {{ font-size:12px; color:var(--sutil); text-align:center; }} a {{ color:var(--acento); }}
dl {{ margin:10px 0 4px; display:grid; gap:2px; }} dl div {{ display:grid; grid-template-columns:80px 1fr; font-size:13px; }}
dt {{ color:var(--sutil); }} dd {{ margin:0; display:flex; gap:6px; align-items:center; }} meter {{ flex:1; }}
.cor {{ display:inline-block; width:12px; height:12px; border-radius:3px; margin-left:3px; vertical-align:middle; border:1px solid var(--linha); }}
.nota {{ font-size:13px; }} .nota label {{ margin-left:6px; }}
</style></head><body><main>
<h1>Qualificação da extração (v2)</h1>
<p class="meta">{len(itens)} elementos de 3 imagens, do melhor para o pior. Nota = 50% fidelidade (SVG desenhado de volta e comparado ao original)
+ 30% resolução de origem + 20% limpeza (fração de caminhos minúsculos, que indicam ruído). ★ = melhor versão quando o mesmo elemento aparece em mais de uma imagem.<br>A nota mede a qualidade do vetor, não se o elemento é estampa: grafismos sem texto (debrum, zíper, emblema de metal) podem tirar nota alta e ainda assim não servirem.</p>
<div class="filtros"><button data-f="" aria-pressed="true">Todos ({len(itens)})</button>{filtros}</div>
<div class="grade">{''.join(cards)}</div></main>
<script>
document.querySelectorAll(".filtros button").forEach(b=>b.addEventListener("click",()=>{{
  document.querySelectorAll(".filtros button").forEach(x=>x.setAttribute("aria-pressed",x===b));
  document.querySelectorAll(".card").forEach(c=>c.hidden=!!b.dataset.f&&c.dataset.classe!==b.dataset.f)}}));
const K="benchmark-vetorizacao-notas";let n={{}};try{{n=JSON.parse(localStorage.getItem(K)||"{{}}")}}catch{{}}
document.querySelectorAll(".nota").forEach(el=>{{const k=el.dataset.chave;if(n[k]){{const i=el.querySelector(`input[value="${{n[k]}}"]`);if(i)i.checked=true}}
el.addEventListener("change",e=>{{n[k]=Number(e.target.value);try{{localStorage.setItem(K,JSON.stringify(n))}}catch{{}}}})}});
</script></body></html>"""


def main() -> None:
    dados = json.loads((SAIDA / "resultados.json").read_text())
    itens = []
    for r in dados:
        pasta = SAIDA / r["pasta"]
        for e in r["elementos"]:
            recorte = Image.open(pasta / f"{e['id']}-recorte.png")
            render, diagonais = desenhar_svg(pasta / f"{e['id']}.svg")
            render.save(pasta / f"{e['id']}-svg-render.png")
            f = fidelidade(recorte, render)
            res = nota_resolucao(*e["recorte_px"])
            limp, frac_ruido = nota_limpeza(diagonais)
            nota = round(100 * (0.5 * f["fidelidade"] + 0.3 * res + 0.2 * limp))
            itens.append({**e, **f, "imagem": r["imagem"], "pasta": r["pasta"], "resolucao": res, "limpeza": limp, "ruido": frac_ruido,
                          "nota": nota, "classe": classe(nota), "grupo": chave_grupo(e["texto"]), "melhor": False})

    grupos: dict[str, list[dict]] = {}
    for i in itens:
        if i["grupo"]:
            grupos.setdefault(i["grupo"], []).append(i)
    for g in grupos.values():
        if len({i["imagem"] for i in g}) > 1 or len(g) > 1:
            max(g, key=lambda i: i["nota"])["melhor"] = True

    itens.sort(key=lambda i: -i["nota"])
    (SAIDA / "qualificacao.json").write_text(json.dumps(
        [{k: i[k] for k in ("imagem", "id", "texto", "nota", "classe", "fidelidade", "iou", "erro_cor", "resolucao", "limpeza", "ruido", "caminhos", "recorte_px", "melhor")} for i in itens],
        indent=2, ensure_ascii=False))
    (SAIDA / "qualificacao.html").write_text(pagina(itens))
    for i in itens:
        print(f"{i['nota']:3} {i['classe']} {'★' if i['melhor'] else ' '} {i['imagem']:20} {i['id']}  fid {i['fidelidade']:.2f} (iou {i['iou']:.2f}, cor {i['erro_cor']:.2f})  res {i['resolucao']:.2f}  limp {i['limpeza']:.2f}  {i['texto'][:30]}")
    print(f"\nRelatório: {SAIDA / 'qualificacao.html'}")


if __name__ == "__main__":
    main()
