"""Pipeline v2: acha os elementos sozinho, agrupa os repetidos, amplia e vetoriza.

1. Detecção por contraste: o que destoa das cores do tecido é estampa. Componentes próximos se juntam
   (símbolo + texto da mesma logo viram um bloco).
2. Florence-2 (leitura de texto com posição): dá nome aos blocos que têm texto.
3. Repetidos (o mesmo logo na frente, nas costas e no zoom): fica só o de maior resolução.
4. Real-ESRGAN (anime 6B, feito para arte chapada) amplia o recorte 4x antes de limpar.
5. Limpeza de cores e vtracer (as mesmas funções do vetorizar.py).

Uso: .venv/bin/python -I extrair.py [imagem.png ...]   (sem argumento: todas de imagens/)
"""

import html
import json
import os
import sys
import time
import warnings
from pathlib import Path
from unittest.mock import patch

warnings.filterwarnings("ignore")
RAIZ = Path(__file__).resolve().parent
os.environ["HF_HOME"] = str(RAIZ / "modelos" / "hf")
os.environ["HF_HUB_OFFLINE"] = "1"
sys.path.insert(0, str(RAIZ))

import numpy as np
import torch
from PIL import Image, ImageFilter
from scipy import ndimage
from sklearn.cluster import MiniBatchKMeans

from vetorizar import abrir, limpar, tracar

SAIDA = RAIZ / "saida-v2"
DISPOSITIVO = "mps" if torch.backends.mps.is_available() else "cpu"
LADO_ANALISE = 1024  # detecção roda numa cópia menor; as caixas voltam para o tamanho original


# ---------- modelos (carregados uma vez, sob demanda) ----------

_florence = None
_esrgan = None


def florence():
    global _florence
    if _florence is None:
        from transformers import AutoModelForCausalLM, AutoProcessor
        from transformers.dynamic_module_utils import get_imports

        def sem_flash_attn(arquivo):  # o código do modelo importa flash_attn, que não existe no Mac
            return [i for i in get_imports(arquivo) if i != "flash_attn"]

        with patch("transformers.dynamic_module_utils.get_imports", sem_flash_attn):
            m = AutoModelForCausalLM.from_pretrained("microsoft/Florence-2-base", trust_remote_code=True, attn_implementation="eager")
        p = AutoProcessor.from_pretrained("microsoft/Florence-2-base", trust_remote_code=True)
        _florence = (m.to(DISPOSITIVO).eval(), p)
    return _florence


def ler_textos(img: Image.Image) -> list[dict]:
    m, p = florence()
    tarefa = "<OCR_WITH_REGION>"
    ent = p(text=tarefa, images=img, return_tensors="pt").to(DISPOSITIVO)
    with torch.no_grad():
        ids = m.generate(input_ids=ent["input_ids"], pixel_values=ent["pixel_values"], max_new_tokens=512, num_beams=3, do_sample=False)
    r = p.post_process_generation(p.batch_decode(ids, skip_special_tokens=False)[0], task=tarefa, image_size=img.size)[tarefa]
    textos = []
    for q, t in zip(r["quad_boxes"], r["labels"]):
        xs, ys = q[0::2], q[1::2]
        textos.append({"texto": t.replace("</s>", "").strip(), "caixa": [min(xs), min(ys), max(xs), max(ys)]})
    return [t for t in textos if t["texto"]]


def ampliar(img: Image.Image) -> Image.Image:
    global _esrgan
    if _esrgan is None:
        from spandrel import ModelLoader

        _esrgan = ModelLoader().load_from_file(str(RAIZ / "modelos" / "RealESRGAN_x4plus_anime_6B.pth")).model.to(DISPOSITIVO).eval()
    t = torch.from_numpy(np.asarray(img, dtype=np.float32) / 255).permute(2, 0, 1)[None].to(DISPOSITIVO)
    with torch.no_grad():
        out = _esrgan(t)
    arr = (out[0].clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).round().astype(np.uint8)
    return Image.fromarray(arr)


# ---------- detecção por contraste ----------


def detectar_blocos(img: Image.Image) -> tuple[list[list[int]], Image.Image]:
    """Caixas (no tamanho de img) das regiões que destoam do tecido. Devolve também a máscara, para depuração."""
    arr = np.asarray(img, dtype=np.float32)
    h, w, _ = arr.shape
    borda = np.concatenate([arr[0], arr[-1], arr[:, 0], arr[:, -1]])
    cor_fundo = np.median(borda, axis=0)
    # Silhueta preenchida: texto branco dentro da peça é parecido com o fundo claro da folha, mas está dentro dela
    peca = ndimage.binary_fill_holes(ndimage.binary_closing(np.linalg.norm(arr - cor_fundo, axis=2) > 40, iterations=2))

    # Cores do tecido: grupos grandes entre os pixels da peça
    px = arr[peca]
    amostra = px[np.random.default_rng(0).choice(len(px), min(len(px), 40_000), replace=False)]
    km = MiniBatchKMeans(n_clusters=6, random_state=0, n_init=3, batch_size=4096).fit(amostra)
    fatia = np.bincount(km.predict(px), minlength=6) / len(px)
    tecido = km.cluster_centers_[fatia >= 0.12]

    dist = np.min(np.linalg.norm(arr[:, :, None, :] - tecido[None, None], axis=3), axis=2)
    grafico = peca & (dist > 70)
    # Longe da borda da peça: a transição peça/fundo e o reflexo de luz nos cantos criam falsos positivos
    peca_interna = ndimage.binary_erosion(peca, iterations=3)
    grafico &= peca_interna
    perto_da_borda = peca & ~ndimage.binary_erosion(peca, iterations=10)

    # Junta letras e símbolo da mesma logo num bloco
    juntado = ndimage.binary_closing(grafico, structure=np.ones((5, 15)), iterations=2)
    juntado = ndimage.binary_dilation(juntado, iterations=2)
    rotulos, n = ndimage.label(juntado)
    caixas = []
    for fatia_obj in ndimage.find_objects(rotulos):
        ys, xs = fatia_obj
        bw, bh = xs.stop - xs.start, ys.stop - ys.start
        pixels = grafico[ys, xs].sum()
        if pixels < 25 or bw * bh < 150:
            continue  # ruído
        if bw > 0.5 * w or bh > 0.5 * h:
            continue  # pega a peça inteira: não é um elemento
        if (grafico[ys, xs] & perto_da_borda[ys, xs]).sum() > 0.3 * pixels:
            continue  # reflexo ou sombra no contorno da peça
        caixas.append([xs.start, ys.start, xs.stop, ys.stop])
    return caixas, Image.fromarray((grafico * 255).astype(np.uint8))


def sobreposicao(a, b) -> float:
    """Fração da caixa b que está dentro de a."""
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    area_b = max(1e-9, (b[2] - b[0]) * (b[3] - b[1]))
    return inter / area_b


def assinatura(img: Image.Image, caixa) -> np.ndarray:
    """Forma do elemento em 24x24 tons de cinza normalizados, para achar repetidos em escalas diferentes."""
    r = img.crop(tuple(caixa)).convert("L").resize((48, 24), Image.BILINEAR)
    a = np.asarray(r, dtype=np.float32)
    return (a - a.mean()) / (a.std() + 1e-6)


def agrupar(elementos: list[dict], img: Image.Image) -> list[dict]:
    """Junta os repetidos (mesmo texto ou mesma forma e proporção) e fica com o de maior área."""
    grupos: list[list[dict]] = []
    for e in sorted(elementos, key=lambda e: -e["area"]):
        e["_sig"] = assinatura(img, e["caixa"])
        e["_prop"] = (e["caixa"][2] - e["caixa"][0]) / max(1, e["caixa"][3] - e["caixa"][1])
        for g in grupos:
            ref = g[0]
            mesmo_texto = e["texto"] and e["texto"].replace(" ", "").upper() == ref["texto"].replace(" ", "").upper()
            forma = float((e["_sig"] * ref["_sig"]).mean())  # correlação
            mesma_forma = abs(np.log(e["_prop"] / ref["_prop"])) < 0.25 and forma > 0.6
            if (mesmo_texto and abs(np.log(e["_prop"] / ref["_prop"])) < 0.5) or mesma_forma:
                g.append(e)
                break
        else:
            grupos.append([e])
    unicos = []
    for g in grupos:
        melhor = dict(g[0])
        melhor["ocorrencias"] = len(g)
        melhor["outras_caixas"] = [x["caixa"] for x in g[1:]]
        for k in ("_sig", "_prop"):
            melhor.pop(k, None)
        unicos.append(melhor)
    return unicos


# ---------- pipeline ----------


def processar(caminho: Path) -> dict:
    nome = caminho.stem
    pasta = SAIDA / nome
    pasta.mkdir(parents=True, exist_ok=True)
    for velho in pasta.glob("elemento-*"):  # rodada anterior pode ter tido mais elementos
        velho.unlink()
    original = abrir(caminho)
    escala = LADO_ANALISE / max(original.size) if max(original.size) > LADO_ANALISE else 1.0
    analise = original.resize((round(original.width * escala), round(original.height * escala)), Image.LANCZOS) if escala < 1 else original

    tempos = {}
    t = time.perf_counter()
    caixas, mascara = detectar_blocos(analise)
    mascara.save(pasta / "_mascara-deteccao.png")
    tempos["deteccao_ms"] = round((time.perf_counter() - t) * 1000)

    t = time.perf_counter()
    textos = ler_textos(original)
    tempos["ocr_ms"] = round((time.perf_counter() - t) * 1000)

    elementos = []
    for c in caixas:
        co = [round(v / escala) for v in c]  # volta para o tamanho original
        dentro = [x["texto"] for x in textos if sobreposicao(co, x["caixa"]) > 0.6]
        elementos.append({"caixa": co, "texto": " / ".join(dentro), "area": (co[2] - co[0]) * (co[3] - co[1])})
    unicos = agrupar(elementos, original)

    resultados = []
    for i, e in enumerate(sorted(unicos, key=lambda e: (e["caixa"][1], e["caixa"][0])), 1):
        x0, y0, x1, y1 = e["caixa"]
        m = max(4, round(0.06 * max(x1 - x0, y1 - y0)))  # margem para o fundo aparecer na borda do recorte
        caixa = (max(0, x0 - m), max(0, y0 - m), min(original.width, x1 + m), min(original.height, y1 + m))
        rec = original.crop(caixa)
        eid = f"elemento-{i:02d}"
        rec.save(pasta / f"{eid}-recorte.png")

        t = time.perf_counter()
        grande = ampliar(rec) if max(rec.size) < 700 else rec
        grande.save(pasta / f"{eid}-ampliado.png")
        ms_ampliar = round((time.perf_counter() - t) * 1000)

        limpo, cores, fundo = limpar(grande, 4, ampliacao=grande.width / rec.width)
        limpo.save(pasta / f"{eid}-limpo.png")
        info = tracar(pasta / f"{eid}-limpo.png", pasta / f"{eid}.svg")
        resultados.append({
            "id": eid, "texto": e["texto"], "tipo": "logo com texto" if e["texto"] else "grafismo",
            "caixa": list(caixa), "ocorrencias": e["ocorrencias"], "cores": cores, "fundo_removido": fundo,
            "recorte_px": list(rec.size), "ampliar_ms": ms_ampliar, **info,
        })
        print(f"  {eid}  {e['texto'] or '(sem texto)':28} x{e['ocorrencias']}  {rec.size[0]}x{rec.size[1]}  {info['caminhos']} caminhos")

    return {"imagem": caminho.name, "pasta": nome, "tempos": tempos, "textos": textos, "elementos": resultados}


def relatorio(todos: list[dict]) -> str:
    secs = []
    for r in todos:
        cards = []
        for e in r["elementos"]:
            chave = html.escape(f"v2::{r['imagem']}::{e['id']}")
            cores = "".join(f'<span class="cor" style="background:{c}" title="{c}"></span>' for c in e["cores"])
            notas = "".join(f'<label><input type="radio" name="{chave}" value="{n}">{n}</label>' for n in range(1, 6))
            titulo = html.escape(e["texto"] or "grafismo sem texto")
            cards.append(f"""<article class="card"><h3>{titulo} <small>×{e['ocorrencias']} na imagem</small></h3>
      <div class="par"><figure><img src="{r['pasta']}/{e['id']}-recorte.png"><figcaption>recorte {e['recorte_px'][0]}×{e['recorte_px'][1]}</figcaption></figure>
      <figure class="xadrez"><img src="{r['pasta']}/{e['id']}.svg"><figcaption>SVG · <a href="{r['pasta']}/{e['id']}.svg" download>baixar</a></figcaption></figure></div>
      <p class="meta">{e['caminhos']} caminhos · {e['kb']} KB · ampliação {e['ampliar_ms']} ms {cores}</p>
      <div class="nota" data-chave="{chave}">Nota: {notas}</div></article>""")
        t = r["tempos"]
        secs.append(f"<section><h2>{html.escape(r['imagem'])} <small>detecção {t['deteccao_ms']} ms · leitura de texto {t['ocr_ms']} ms · {len(r['elementos'])} elementos únicos</small></h2>"
                    f"<div class='grade'>{''.join(cards)}</div></section>")
    return f"""<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Extração automática</title><style>
:root {{ --fundo:#f6f6f4; --card:#fff; --texto:#1d1d1b; --sutil:#6b6b66; --linha:#e2e2dc; --acento:#c2410c; }}
@media (prefers-color-scheme: dark) {{ :root {{ --fundo:#161615; --card:#1f1f1d; --texto:#ecece8; --sutil:#a3a39c; --linha:#33332f; --acento:#fb923c; }} }}
body {{ margin:0; padding:24px 16px; background:var(--fundo); color:var(--texto); font:15px/1.5 system-ui, sans-serif; }}
header, section {{ max-width:1200px; margin:0 auto 32px; }} h1 {{ font-size:22px; margin:0 0 4px; }} h2 {{ font-size:18px; }}
h2 small, h3 small, .meta {{ color:var(--sutil); font-weight:400; font-size:13px; }} h3 {{ margin:0 0 8px; font-size:14px; }}
.grade {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:16px; }}
.card {{ background:var(--card); border:1px solid var(--linha); border-radius:10px; padding:14px; }}
.par {{ display:grid; grid-template-columns:1fr 1fr; gap:8px; }} figure {{ margin:0; }}
figure img {{ width:100%; aspect-ratio:1; object-fit:contain; border-radius:6px; border:1px solid var(--linha); background:#fff; }}
.xadrez img {{ background:repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0/16px 16px; }}
figcaption {{ font-size:12px; color:var(--sutil); text-align:center; }} a {{ color:var(--acento); }}
.cor {{ display:inline-block; width:12px; height:12px; border-radius:3px; margin-left:3px; vertical-align:middle; border:1px solid var(--linha); }}
.nota label {{ margin-left:8px; }}
</style></head><body><header><h1>Extração automática (pipeline v2)</h1>
<p class="meta">Sem caixas marcadas à mão: detecção por contraste + Florence-2 + Real-ESRGAN + vtracer. Tudo local.</p></header>
{''.join(secs)}
<script>const K="benchmark-vetorizacao-notas";let n={{}};try{{n=JSON.parse(localStorage.getItem(K)||"{{}}")}}catch{{}}
document.querySelectorAll(".nota").forEach(el=>{{const k=el.dataset.chave;if(n[k]){{const i=el.querySelector(`input[value="${{n[k]}}"]`);if(i)i.checked=true}}
el.addEventListener("change",e=>{{n[k]=Number(e.target.value);try{{localStorage.setItem(K,JSON.stringify(n))}}catch{{}}}})}});</script></body></html>"""


def main() -> None:
    nomes = sys.argv[1:]
    imagens = [RAIZ / "imagens" / n for n in nomes] if nomes else sorted(p for p in (RAIZ / "imagens").iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"})
    SAIDA.mkdir(exist_ok=True)
    todos = []
    for c in imagens:
        print(c.name)
        todos.append(processar(c))
    (SAIDA / "resultados.json").write_text(json.dumps(todos, indent=2, ensure_ascii=False))
    (SAIDA / "index.html").write_text(relatorio(todos))
    print(f"\nRelatório: {SAIDA / 'index.html'}")


if __name__ == "__main__":
    main()
