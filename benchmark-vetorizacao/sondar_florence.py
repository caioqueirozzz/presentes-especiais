"""Sonda o Florence-2: que tarefa acha melhor os elementos das peças."""
import os, sys, time, warnings
from pathlib import Path
from unittest.mock import patch
warnings.filterwarnings("ignore")
RAIZ = Path(__file__).resolve().parent
os.environ["HF_HOME"] = str(RAIZ / "modelos" / "hf")
os.environ["HF_HUB_OFFLINE"] = "1"
import torch
from PIL import Image
from transformers import AutoModelForCausalLM, AutoProcessor
from transformers.dynamic_module_utils import get_imports

def sem_flash_attn(arquivo):
    return [i for i in get_imports(arquivo) if i != "flash_attn"]

with patch("transformers.dynamic_module_utils.get_imports", sem_flash_attn):
    modelo = AutoModelForCausalLM.from_pretrained("microsoft/Florence-2-base", trust_remote_code=True, attn_implementation="eager").eval()
proc = AutoProcessor.from_pretrained("microsoft/Florence-2-base", trust_remote_code=True)

def rodar(img, tarefa, texto=""):
    t = time.perf_counter()
    ent = proc(text=tarefa + texto, images=img, return_tensors="pt")
    with torch.no_grad():
        ids = modelo.generate(input_ids=ent["input_ids"], pixel_values=ent["pixel_values"], max_new_tokens=512, num_beams=3, do_sample=False)
    bruto = proc.batch_decode(ids, skip_special_tokens=False)[0]
    r = proc.post_process_generation(bruto, task=tarefa, image_size=img.size)
    return r, round(time.perf_counter() - t, 1)

img = Image.open(RAIZ / "imagens" / sys.argv[1]).convert("RGB")
for tarefa, texto in [("<OD>", ""), ("<CAPTION_TO_PHRASE_GROUNDING>", "logo"), ("<OPEN_VOCABULARY_DETECTION>", "logo"), ("<OCR_WITH_REGION>", "")]:
    r, s = rodar(img, tarefa, texto)
    print(tarefa, texto, f"{s}s", r)
