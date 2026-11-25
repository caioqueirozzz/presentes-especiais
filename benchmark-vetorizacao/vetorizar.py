"""Benchmark de vetorização (spec do módulo de design, seção 12).

Para cada imagem em imagens/, gera variantes de SVG com o vtracer e um relatório HTML para o designer
dar nota de 1 a 5. Tudo local e sem custo.

Variantes:
  bruto       imagem inteira direto no vtracer (linha de base)
  limpo       sem ruído de JPEG, fundo removido (cor dominante da borda) e cores reduzidas por k-means
  recorte-N   o mesmo "limpo", só na região de cada elemento listado em recortes.json, ampliada antes

recortes.json (opcional), caixas em fração da imagem (0 a 1), [x, y, largura, altura]:
  { "camisa-1.jpg": [ {"nome": "escudo", "caixa": [0.55, 0.25, 0.15, 0.15], "cores": 4} ] }

Uso: .venv/bin/python -I vetorizar.py [--cores 6]
"""

import argparse
import html
import json
import re
import time
from pathlib import Path

import numpy as np
import vtracer
from PIL import Image, ImageFilter, ImageOps
from sklearn.cluster import MiniBatchKMeans

RAIZ = Path(__file__).resolve().parent
ENTRADA = RAIZ / "imagens"
SAIDA = RAIZ / "saida"
EXTENSOES = {".png", ".jpg", ".jpeg", ".webp"}
LADO_MAX = 1600  # imagem inteira: limita o tempo do vtracer
LADO_RECORTE = 1000  # recorte: amplia até aqui, o vtracer traça melhor com mais pixels


def abrir(caminho: Path) -> Image.Image:
    img = ImageOps.exif_transpose(Image.open(caminho)).convert("RGBA")
    # PNG transparente: o fundo vira branco para não confundir a remoção de fundo (igual à paleta do CRM, M7)
    branco = Image.new("RGBA", img.size, (255, 255, 255, 255))
    return Image.alpha_composite(branco, img).convert("RGB")


def limitar(img: Image.Image, lado: int, ampliar: bool = False) -> Image.Image:
    escala = lado / max(img.size)
    if escala >= 1 and not ampliar:
        return img
    return img.resize((round(img.width * escala), round(img.height * escala)), Image.LANCZOS)


def limpar(img: Image.Image, n_cores: int, ampliacao: float = 1.0) -> tuple[Image.Image, list[str], bool]:
    """ampliacao: quanto a imagem foi ampliada; a espessura das bordas é medida no tamanho original.

    Tira ruído, reduz às n cores dominantes e torna transparente a cor que domina a borda (fundo)."""
    suave = img.filter(ImageFilter.MedianFilter(3))
    px = np.asarray(suave, dtype=np.float32).reshape(-1, 3)
    amostra = px[np.random.default_rng(0).choice(len(px), min(len(px), 60_000), replace=False)]
    # Dois grupos a mais que o pedido: as bordas de transição ganham grupo próprio (e são juntadas abaixo)
    # em vez de puxar uma cor de verdade para o meio do caminho
    n_cores += 2
    km = MiniBatchKMeans(n_clusters=n_cores, random_state=0, n_init=3, batch_size=4096).fit(amostra)
    rotulos = km.predict(px)
    centros = np.clip(km.cluster_centers_, 0, 255).astype(np.uint8)
    # Quase branco e quase preto neutros viram branco e preto puros (linha, bordado e texto costumam ser isso)
    for k, cor in enumerate(centros.astype(int)):
        if cor.max() - cor.min() < 30 and cor.mean() > 200:
            centros[k] = 255
        elif cor.max() - cor.min() < 30 and cor.mean() < 30:
            centros[k] = 0

    # Grupo cuja cor fica no meio do caminho entre duas outras cores E que só forma faixas finas é a borda
    # borrada entre elas (antialias/JPEG) e viraria um contorno falso no SVG: vai para a mais próxima das duas.
    # Cor própria da logo (fora da linha entre duas cores, ou com área cheia) fica, mesmo pequena.
    fatia = np.bincount(rotulos, minlength=n_cores) / len(rotulos)
    grade0 = rotulos.reshape(img.height, img.width)
    destino = np.arange(n_cores)
    c = centros.astype(float)
    for i in np.flatnonzero((fatia > 0) & (fatia < 0.10)):
        outros = [j for j in range(n_cores) if j != i and fatia[j] > fatia[i]]
        mascara = Image.fromarray(((grade0 == i) * 255).astype(np.uint8))
        if ampliacao > 1:
            nativo = (max(1, round(img.width / ampliacao)), max(1, round(img.height / ampliacao)))
            mascara = mascara.resize(nativo, Image.BOX).point(lambda v: 255 if v > 127 else 0)
        miolo = np.asarray(mascara.filter(ImageFilter.MinFilter(7))) > 0
        if miolo.sum() > 0.2 * (np.asarray(mascara) > 0).sum():
            continue  # tem área cheia: é cor de verdade
        melhor = None
        for ai, a in enumerate(outros):
            for b in outros[ai + 1:]:
                ab = c[b] - c[a]
                t = np.clip(np.dot(c[i] - c[a], ab) / max(np.dot(ab, ab), 1e-9), 0.15, 0.85)
                d = np.linalg.norm(c[a] + t * ab - c[i])
                if d < 30 and (melhor is None or d < melhor[0]):
                    melhor = (d, a if t < 0.5 else b)
        if melhor:
            destino[i] = melhor[1]
    rotulos = destino[rotulos]
    presentes = set(np.unique(rotulos).tolist())

    h, w = img.height, img.width
    grade = rotulos.reshape(h, w)
    borda = np.concatenate([grade[0], grade[-1], grade[:, 0], grade[:, -1]])
    na_borda = np.bincount(borda, minlength=n_cores) / len(borda)
    dominante = na_borda.argmax()
    # Tecido com textura se divide em tons vizinhos: entram no fundo as cores parecidas com a dominante
    # que também aparecem bastante na borda
    reais = km.cluster_centers_  # antes de forçar branco/preto, que afastaria dois tons do mesmo tecido
    perto = np.linalg.norm(reais - reais[dominante], axis=1) < 45
    fundo = np.flatnonzero((na_borda >= 0.05) & perto)
    tem_fundo = na_borda[fundo].sum() >= 0.8  # mesmo corte da paleta do CRM (D13)

    rgba = np.zeros((h * w, 4), dtype=np.uint8)
    rgba[:, :3] = centros[rotulos]
    rgba[:, 3] = 255
    if tem_fundo:
        rgba[np.isin(rotulos, fundo), 3] = 0
    usadas = [i for i in sorted(presentes) if not (tem_fundo and i in fundo)]
    cores = ["#%02x%02x%02x" % tuple(centros[i]) for i in usadas]
    return Image.fromarray(rgba.reshape(h, w, 4)), cores, bool(tem_fundo)


def tracar(png: Path, svg: Path) -> dict:
    inicio = time.perf_counter()
    vtracer.convert_image_to_svg_py(
        str(png), str(svg),
        colormode="color", hierarchical="stacked", mode="spline",
        filter_speckle=8, color_precision=6, layer_difference=24,
        corner_threshold=60, length_threshold=4.0, max_iterations=10,
        splice_threshold=45, path_precision=2,
    )
    texto = svg.read_text()
    return {"ms": round((time.perf_counter() - inicio) * 1000), "kb": round(len(texto) / 1024, 1), "caminhos": len(re.findall(r"<path", texto))}


def processar(caminho: Path, recortes: list[dict], n_cores: int) -> dict:
    nome = caminho.stem
    pasta = SAIDA / nome
    pasta.mkdir(parents=True, exist_ok=True)
    original = abrir(caminho)
    base = limitar(original, LADO_MAX)
    base.save(pasta / "original.png")
    variantes = []

    tracar_bruto = tracar(pasta / "original.png", pasta / "bruto.svg")
    variantes.append({"id": "bruto", "titulo": "Bruto (direto no vtracer)", "svg": "bruto.svg", "previa": "original.png", **tracar_bruto})

    limpa, cores, fundo = limpar(base, n_cores)
    limpa.save(pasta / "limpo.png")
    variantes.append({"id": "limpo", "titulo": f"Limpo ({n_cores} cores, fundo {'removido' if fundo else 'mantido'})",
                      "svg": "limpo.svg", "previa": "limpo.png", "cores": cores, **tracar(pasta / "limpo.png", pasta / "limpo.svg")})

    for i, r in enumerate(recortes, 1):
        x, y, cw, ch = r["caixa"]
        caixa = (round(x * original.width), round(y * original.height), round((x + cw) * original.width), round((y + ch) * original.height))
        bruto_rec = original.crop(caixa)
        rec = limitar(bruto_rec, LADO_RECORTE, ampliar=True)
        rid = f"recorte-{i}"
        rec.save(pasta / f"{rid}-original.png")
        limpo_rec, cores_rec, fundo_rec = limpar(rec, r.get("cores", 4), rec.width / bruto_rec.width)
        limpo_rec.save(pasta / f"{rid}.png")
        variantes.append({"id": rid, "titulo": f"Recorte: {r.get('nome', rid)} ({r.get('cores', 4)} cores, fundo {'removido' if fundo_rec else 'mantido'})",
                          "svg": f"{rid}.svg", "previa": f"{rid}-original.png", "cores": cores_rec, **tracar(pasta / f"{rid}.png", pasta / f"{rid}.svg")})

    return {"imagem": caminho.name, "pasta": nome, "tamanho": list(original.size), "variantes": variantes}


def relatorio(resultados: list[dict]) -> str:
    blocos = []
    for r in resultados:
        cards = []
        for v in r["variantes"]:
            chave = html.escape(f"{r['imagem']}::{v['id']}")
            cores = "".join(f'<span class="cor" style="background:{c}" title="{c}"></span>' for c in v.get("cores", []))
            notas = "".join(f'<label><input type="radio" name="{chave}" value="{n}">{n}</label>' for n in range(1, 6))
            cards.append(f"""
      <article class="card">
        <h3>{html.escape(v['titulo'])}</h3>
        <div class="par">
          <figure><img src="{r['pasta']}/{v['previa']}" alt="entrada"><figcaption>entrada</figcaption></figure>
          <figure class="xadrez"><img src="{r['pasta']}/{v['svg']}" alt="svg"><figcaption>SVG · <a href="{r['pasta']}/{v['svg']}" download>baixar</a></figcaption></figure>
        </div>
        <p class="meta">{v['ms']} ms · {v['kb']} KB · {v['caminhos']} caminhos · custo R$ 0 {cores}</p>
        <div class="nota" data-chave="{chave}">Nota do designer: {notas}</div>
      </article>""")
        blocos.append(f"<section><h2>{html.escape(r['imagem'])} <small>{r['tamanho'][0]}×{r['tamanho'][1]}</small></h2><div class=\"grade\">{''.join(cards)}</div></section>")

    return f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Benchmark de vetorização</title>
<style>
  :root {{ --fundo:#f6f6f4; --card:#fff; --texto:#1d1d1b; --sutil:#6b6b66; --linha:#e2e2dc; --acento:#c2410c; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --fundo:#161615; --card:#1f1f1d; --texto:#ecece8; --sutil:#a3a39c; --linha:#33332f; --acento:#fb923c; }} }}
  body {{ margin:0; padding:24px 16px; background:var(--fundo); color:var(--texto); font:15px/1.5 system-ui, sans-serif; }}
  header, section {{ max-width:1200px; margin:0 auto 32px; }}
  h1 {{ margin:0 0 4px; font-size:22px; }} h2 {{ font-size:18px; }} h2 small, .meta {{ color:var(--sutil); font-weight:400; font-size:13px; }}
  h3 {{ margin:0 0 8px; font-size:14px; }}
  .grade {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:16px; }}
  .card {{ background:var(--card); border:1px solid var(--linha); border-radius:10px; padding:14px; }}
  .par {{ display:grid; grid-template-columns:1fr 1fr; gap:8px; }}
  figure {{ margin:0; }} figure img {{ width:100%; aspect-ratio:1; object-fit:contain; border-radius:6px; border:1px solid var(--linha); background:#fff; }}
  .xadrez img {{ background:repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0/16px 16px; }}
  figcaption {{ font-size:12px; color:var(--sutil); text-align:center; }} a {{ color:var(--acento); }}
  .cor {{ display:inline-block; width:12px; height:12px; border-radius:3px; margin-left:3px; vertical-align:middle; border:1px solid var(--linha); }}
  .nota label {{ margin-left:8px; cursor:pointer; }} button {{ font:inherit; padding:6px 14px; border-radius:6px; border:1px solid var(--linha); background:var(--card); color:var(--texto); cursor:pointer; }}
</style></head><body>
<header><h1>Benchmark de vetorização</h1>
<p class="meta">vtracer local. Critério da spec: nota média ≥ 3 nas logos chapadas. As notas ficam neste navegador; use "Exportar notas" para salvar.</p>
<button id="exportar">Exportar notas (JSON)</button></header>
{''.join(blocos)}
<script>
  const CHAVE = "benchmark-vetorizacao-notas";
  let notas = {{}};
  try {{ notas = JSON.parse(localStorage.getItem(CHAVE) || "{{}}"); }} catch {{}}
  document.querySelectorAll(".nota").forEach((el) => {{
    const k = el.dataset.chave;
    if (notas[k]) {{ const i = el.querySelector(`input[value="${{notas[k]}}"]`); if (i) i.checked = true; }}
    el.addEventListener("change", (e) => {{ notas[k] = Number(e.target.value); try {{ localStorage.setItem(CHAVE, JSON.stringify(notas)); }} catch {{}} }});
  }});
  document.getElementById("exportar").onclick = () => {{
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(notas, null, 2)], {{ type: "application/json" }}));
    a.download = "notas-vetorizacao.json"; a.click();
  }};
</script></body></html>"""


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--cores", type=int, default=6, help="cores do k-means na imagem inteira")
    args = p.parse_args()

    imagens = sorted(c for c in ENTRADA.iterdir() if c.suffix.lower() in EXTENSOES)
    if not imagens:
        raise SystemExit(f"Nenhuma imagem em {ENTRADA}")
    arq_recortes = RAIZ / "recortes.json"
    recortes = json.loads(arq_recortes.read_text()) if arq_recortes.exists() else {}

    resultados = []
    for c in imagens:
        r = processar(c, recortes.get(c.name, []), args.cores)
        resultados.append(r)
        for v in r["variantes"]:
            print(f"{c.name:28} {v['id']:10} {v['ms']:>6} ms {v['kb']:>8} KB {v['caminhos']:>5} caminhos")

    (SAIDA / "resultados.json").write_text(json.dumps(resultados, indent=2, ensure_ascii=False))
    (SAIDA / "index.html").write_text(relatorio(resultados))
    print(f"\nRelatório: {SAIDA / 'index.html'}")


if __name__ == "__main__":
    main()
