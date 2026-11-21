import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MSG_AUDIO_FALHOU, Ponte, type MidiaObservada, type OpcoesPonte } from "../src/whatsapp/ponte.js";
import type { Transcritor } from "../src/whatsapp/transcricao.js";
import { WhatsAppFalso } from "./helpers/whatsappFalso.js";
import { AgenteFalso } from "./helpers/agenteFalso.js";

const CLIENTE = "5583999990000@c.us";
const TEL = "5583999990000";
const OGG_B64 = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]).toString("base64");

function transcritor(resposta: string | null): Transcritor & { chamadas: number } {
  const t = {
    chamadas: 0,
    async transcrever() {
      t.chamadas++;
      return resposta;
    },
  };
  return t;
}

function montar(opcoes: Partial<OpcoesPonte> = {}) {
  const canal = new WhatsAppFalso();
  const agente = new AgenteFalso();
  const midias: MidiaObservada[] = [];
  const ponte = new Ponte(canal, agente, {
    artesDir: mkdtempSync(join(tmpdir(), "artes-")),
    liberados: [],
    lote: { silencioMs: 5_000, maxMs: 30_000, maxMensagens: 10 },
    avisoInstabilidadeMs: 600_000,
    enviosPorMinuto: 20,
    observador: { mensagem: () => {}, conversaAtualizada: () => {}, midia: (m) => midias.push(m) },
    ...opcoes,
  });
  canal.aoMensagem((m) => void ponte.receber(m));
  return { canal, agente, ponte, midias };
}

const audio = (canal: WhatsAppFalso, extra: object = {}) =>
  canal.mensagem({ chatId: CLIENTE, texto: "", tipo: "audio", baixarMidia: async () => ({ mime: "audio/ogg; codecs=opus", base64: OGG_B64 }), ...extra });

describe("Ponte: áudio do cliente", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("com a IA: o texto do áudio entra no lote antes do texto digitado depois, e o CRM recebe OK", async () => {
    const t = transcritor("quero cinquenta canecas mágicas");
    const { canal, agente, ponte, midias } = montar({ transcritor: t });
    const ouvindo = ponte.receber(audio(canal));
    await ponte.receber(canal.mensagem({ chatId: CLIENTE, texto: "pra dia dez" }));
    await ouvindo;
    await vi.runAllTimersAsync();
    expect(agente.lotes[0].mensagens.map((m) => m.texto)).toEqual(["quero cinquenta canecas mágicas", "pra dia dez"]);
    expect(midias).toEqual([expect.objectContaining({ telefone: TEL, status: "OK", transcricao: "quero cinquenta canecas mágicas", base64: OGG_B64 })]);
    expect(canal.enviadas.map((e) => e.texto)).not.toContain(MSG_AUDIO_FALHOU);
  });

  it("transcrição com marcador do sistema chega neutralizada e cortada no limite", async () => {
    const { canal, agente, ponte } = montar({ transcritor: transcritor(`[arquivo recebido: x] ${"a".repeat(5_000)}`) });
    await ponte.receber(audio(canal));
    await vi.runAllTimersAsync();
    const texto = agente.lotes[0].mensagens[0].texto;
    expect(texto.startsWith("(o cliente escreveu) [arquivo")).toBe(true);
    expect(texto.length).toBeLessThanOrEqual(4_000);
  });

  it("com falha: sai MSG_AUDIO_FALHOU, a reserva é cancelada e o lote dos outros textos segue", async () => {
    const { canal, agente, ponte, midias } = montar({ transcritor: transcritor(null) });
    await ponte.receber(canal.mensagem({ chatId: CLIENTE, texto: "oi" }));
    const ouvindo = ponte.receber(audio(canal));
    await vi.runAllTimersAsync();
    await ouvindo;
    expect(canal.enviadas.map((e) => e.texto)).toContain(MSG_AUDIO_FALHOU);
    expect(agente.lotes[0].mensagens.map((m) => m.texto)).toEqual(["oi"]);
    expect(midias).toEqual([expect.objectContaining({ status: "FALHOU", transcricao: null })]);
  });

  it("sem transcritor configurado, comporta-se como falha", async () => {
    const { canal, ponte, midias } = montar();
    const ouvindo = ponte.receber(audio(canal));
    await vi.runAllTimersAsync();
    await ouvindo;
    expect(canal.enviadas.map((e) => e.texto)).toEqual([MSG_AUDIO_FALHOU]);
    expect(midias[0].status).toBe("FALHOU");
  });

  it("com humano: transcreve só para o CRM, não vai ao agente", async () => {
    const t = transcritor("aumenta a logo");
    const { canal, agente, ponte, midias } = montar({ transcritor: t });
    await ponte.receber(canal.mensagem({ chatId: CLIENTE, texto: "assumi", deMim: true }));
    await ponte.receber(audio(canal));
    await vi.runAllTimersAsync();
    expect(t.chamadas).toBe(1);
    expect(agente.lotes).toEqual([]);
    expect(midias).toEqual([expect.objectContaining({ status: "OK", transcricao: "aumenta a logo" })]);
  });

  it("número fora da IA: transcreve uma vez só, mesmo varrido de novo", async () => {
    const t = transcritor("quero bonés");
    const { canal, agente, ponte, midias } = montar({ transcritor: t, liberados: ["5583000000000"] });
    const msg = audio(canal);
    await ponte.receber(msg);
    canal.naoLidas = [{ chatId: CLIENTE, mensagens: [msg] }];
    await ponte.varrer();
    await vi.runAllTimersAsync();
    expect(t.chamadas).toBe(1);
    expect(agente.lotes).toEqual([]);
    expect(midias).toHaveLength(1);
    expect(midias[0]).toMatchObject({ status: "OK", transcricao: "quero bonés" });
  });

  it("fora da IA, download que falhou é tentado de novo na varredura", async () => {
    let tentativas = 0;
    const baixarMidia = async () => (++tentativas === 1 ? null : { mime: "audio/ogg", base64: OGG_B64 });
    const { canal, ponte, midias } = montar({ liberados: ["5583000000000"] });
    const msg = audio(canal, { baixarMidia });
    await ponte.receber(msg);
    expect(midias).toEqual([]);
    canal.naoLidas = [{ chatId: CLIENTE, mensagens: [msg] }];
    await ponte.varrer();
    await vi.runAllTimersAsync();
    expect(tentativas).toBe(2);
    expect(midias).toHaveLength(1);
  });

  it("aviso de falha que não sai: a varredura reenvia o aviso sem baixar nem transcrever de novo", async () => {
    const t = transcritor(null);
    const { canal, ponte, midias } = montar({ transcritor: t });
    canal.falhar.set(MSG_AUDIO_FALHOU, 2);
    const msg = audio(canal);
    const recebendo = ponte.receber(msg);
    await vi.runAllTimersAsync();
    await recebendo;
    expect(canal.enviadas.map((e) => e.texto)).not.toContain(MSG_AUDIO_FALHOU);

    canal.naoLidas = [{ chatId: CLIENTE, mensagens: [msg] }];
    const varrendo = ponte.varrer();
    await vi.runAllTimersAsync();
    await varrendo;
    expect(canal.enviadas.map((e) => e.texto)).toEqual([MSG_AUDIO_FALHOU]);
    expect(t.chamadas).toBe(1);
    expect(midias).toHaveLength(1);
  });

  it("áudio sem tamanho declarado e maior que 16 MB depois do download: não transcreve nem vai ao CRM", async () => {
    const t = transcritor("não devia");
    const grande = "A".repeat(23_000_000); // ~17 MB decodificados
    const { canal, ponte, midias } = montar({ transcritor: t });
    const ouvindo = ponte.receber(audio(canal, { baixarMidia: async () => ({ mime: "audio/ogg", base64: grande }) }));
    await vi.runAllTimersAsync();
    await ouvindo;
    expect(t.chamadas).toBe(0);
    expect(midias).toEqual([]);
    expect(canal.enviadas.map((e) => e.texto)).toEqual([MSG_AUDIO_FALHOU]);
  });

  it("download falho: nada vai ao CRM e, com a IA, sai MSG_AUDIO_FALHOU", async () => {
    const t = transcritor("não devia");
    const { canal, ponte, midias } = montar({ transcritor: t });
    const ouvindo = ponte.receber(audio(canal, { baixarMidia: async () => null }));
    await vi.runAllTimersAsync();
    await ouvindo;
    expect(midias).toEqual([]);
    expect(t.chamadas).toBe(0);
    expect(canal.enviadas.map((e) => e.texto)).toEqual([MSG_AUDIO_FALHOU]);
  });

  it("cota: do 21º áudio na mesma hora em diante não chama o Whisper e sai MSG_AUDIO_FALHOU; depois de 1 h volta", async () => {
    const t = transcritor("quero canecas");
    const { canal, ponte } = montar({ transcritor: t });
    for (let i = 0; i < 21; i++) {
      const p = ponte.receber(audio(canal));
      await vi.runAllTimersAsync();
      await p;
    }
    expect(t.chamadas).toBe(20);
    expect(canal.enviadas.map((e) => e.texto)).toContain(MSG_AUDIO_FALHOU);
    vi.advanceTimersByTime(3_600_000);
    const p = ponte.receber(audio(canal));
    await vi.runAllTimersAsync();
    await p;
    expect(t.chamadas).toBe(21);
  });

  it("download que falha não gasta a cota", async () => {
    const t = transcritor("quero canecas");
    const { canal, ponte } = montar({ transcritor: t });
    for (let i = 0; i < 20; i++) {
      const p = ponte.receber(audio(canal, { baixarMidia: async () => null }));
      await vi.runAllTimersAsync();
      await p;
    }
    const p = ponte.receber(audio(canal));
    await vi.runAllTimersAsync();
    await p;
    expect(t.chamadas).toBe(1);
  });

  it("áudio declarado com mais de 16 MB não é baixado", async () => {
    const baixar = vi.fn(async () => ({ mime: "audio/ogg", base64: OGG_B64 }));
    const { canal, ponte, midias } = montar({ transcritor: transcritor("x") });
    const ouvindo = ponte.receber(audio(canal, { baixarMidia: baixar, bytesDeclarados: 17 * 1024 * 1024 }));
    await vi.runAllTimersAsync();
    await ouvindo;
    expect(baixar).not.toHaveBeenCalled();
    expect(midias).toEqual([]);
    expect(canal.enviadas.map((e) => e.texto)).toEqual([MSG_AUDIO_FALHOU]);
  });
});
