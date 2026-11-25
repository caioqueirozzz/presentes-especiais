# Benchmark de vetorização (Módulo Design)

Extrai logos, estampas e textos das imagens de produto geradas por IA e transforma em SVG. Roda tudo local, sem custo de API.

| Script | O que faz | Saída |
|---|---|---|
| `vetorizar.py` | v1: vetoriza a imagem inteira e os recortes marcados à mão em `recortes.json` (vtracer + limpeza de cores) | `saida/index.html` |
| `extrair.py` | v2: acha os elementos sozinho (contraste + Florence-2), descarta os repetidos, amplia 4x com Real-ESRGAN e vetoriza | `saida-v2/index.html` |
| `qualificar.py` | Dá nota de 0 a 100 a cada elemento da v2 e o classifica em A, B ou C | `saida-v2/qualificacao.html` |
| `sondar_florence.py` | Testa quais tarefas do Florence-2 encontram melhor os elementos | terminal |

## Como rodar

```bash
cd benchmark-vetorizacao
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

mkdir -p imagens          # coloque aqui as imagens das peças (.png/.jpg)
.venv/bin/python -I vetorizar.py      # v1
```

Para a v2, baixe os modelos antes (cerca de 0,5 GB):

```bash
mkdir -p modelos
curl -L -o modelos/RealESRGAN_x4plus_anime_6B.pth \
  https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth
HF_HOME=modelos/hf .venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('microsoft/Florence-2-base')"

.venv/bin/python -I extrair.py        # v2 (roda offline depois do download)
.venv/bin/python -I qualificar.py     # notas e classes
```

`imagens/`, `modelos/`, `saida/`, `saida-v2/` e `.venv/` ficam fora do git (ver `.gitignore`).

`recortes.exemplo.json` mostra o formato das caixas da v1. `recortes.json` traz as caixas usadas nas 3 imagens do teste (camisa-1-cto, camisa-2-slogan, bone).
