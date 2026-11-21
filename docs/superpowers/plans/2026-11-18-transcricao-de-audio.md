# Transcrição de áudio — plano de implementação

> **Para quem for executar:** use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans, tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** a Lia entende áudio do cliente (Whisper → texto no lote) e o CRM guarda o áudio com player e transcrição no painel do lead.

**Arquitetura:** a ponte baixa todo áudio direto do cliente uma vez. Com a IA atendendo, transcreve e põe o texto no lote, no lugar reservado antes do download. Em qualquer modo, manda o áudio ao CRM por uma rota nova (`/api/integracao/midias`), na mesma fila FIFO das mensagens. O CRM grava no `Armazem` do Módulo Design e serve o áudio por redirect para a URL temporária.

**Stack:** TypeScript, SDK `openai` 7.23 (`toFile`, `audio.transcriptions.create`), vitest (agente: fake timers; CRM: pglite), Next.js (rotas do CRM), React (painel).

**Spec:** `docs/superpowers/specs/2026-11-16-transcricao-de-audio-design.md`

**Base:** a `banco-neon` local (worktree `repo-busca-semantica`), que já tem o Módulo Design junto. A spec mandava partir da `transcricao-de-audio` e juntar a `quadro-de-design`; isso não vale mais: o `Armazem` e o pglite do CRM já estão aqui. Nada de push nem PR (regra de 18/11: o PR definitivo sai da etapa de validação).

## Restrições globais

- Modelo: `process.env.TRANSCRICAO_MODELO || "whisper-1"`, com `language: "pt"` e `response_format: "text"`. Chave: a `OPENAI_API_KEY` que já existe.
- 3 tentativas, timeout de 60 s cada (`new OpenAI({ timeout: 60_000, maxRetries: 0 })`), pausas de 1 s e 3 s entre elas.
- Teto de 16 MB (`TAMANHO_MAXIMO_BYTES` na ponte, `LIMITE_BYTES` no CRM).
- Mensagem fixa: `MSG_AUDIO_FALHOU = "Não consegui ouvir seu áudio direito. Pode me mandar por escrito?"`. A `MSG_AUDIO` sai.
- O log nunca leva o texto transcrito nem os bytes.
- Repositório público: nenhum áudio real em fixture, commit ou issue. As fixtures usam `OggS` seguido de zeros e transcrições inventadas.
- Banco do CRM: só o Docker (5440, banco `crm`). Nunca migration do CRM contra Neon.
- O prompt da Lia não muda, e os evals não mudam.
- Commits locais, um por tarefa, com o trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Sem push.

## Desvios da spec (decididos neste plano)

1. **`detectarAudio` separado do `detectarTipo`** (`crm/src/lib/arquivos.ts`). O `detectarTipo` alimenta o `validarImagens` do design, e acrescentar áudio ali faria uma nota de voz virar referência de design.
2. **`chaveSegura` passa a aceitar `audios/`.** Hoje ela só aceita `design/`, e o `Armazem` recusaria a chave da spec.
3. **Áudio de lead fora do escopo responde 404, não 403.** O `getLeadForUser` já devolve `null` para lead fora do escopo, como no `GET /api/leads/[id]`, e assim não se revela se o lead existe.
4. **Áudio fora da IA é mandado ao CRM uma vez só** (`ConjuntoLimitado`). Sem isso, a varredura rebaixaria a cada passada o áudio não lido de um número fora da IA.
5. **`ObservadorPonte.midia` é opcional** (`midia?`). Os observadores de teste que já existem não precisam mudar. Sem observador, a ponte nem baixa o áudio fora da IA.

## Foco da revisão

1. **Número fora da IA, varrido de novo:** o áudio é baixado e mandado ao CRM uma vez só. Teste na Tarefa 2.
2. **Áudio declarado com mais de 16 MB:** não é baixado. Com a IA, sai `MSG_AUDIO_FALHOU`. Teste na Tarefa 2.
3. **Transcrição com `[arquivo …]` ou maior que `LIMITE_TEXTO`:** chega neutralizada e cortada ao agente. Teste na Tarefa 2.
4. **`Range` malformado ou além do fim no player:** responde 416 ou o arquivo inteiro, sem quebrar. Teste na Tarefa 5.
5. **Bytes de PNG mandados como áudio para `/midias`:** 422, e o design continua recusando áudio. Testes na Tarefa 4.

---

### Tarefa 1: Transcritor

**Arquivos:**
- Criar: `src/whatsapp/transcricao.ts`
- Criar: `tests/transcricao.test.ts`
- Modificar: `.env.example` (raiz)

**Interfaces:**
- Produz: `interface Transcritor { transcrever(dados: Buffer, mime: string): Promise<string | null> }`, `interface ClienteTranscricao`, `transcritorOpenAI(cliente: ClienteTranscricao, modelo: string, log: LogPonte, pausa?: (ms: number) => Promise<void>): Transcritor`, `PROMPT_TRANSCRICAO`.

- [ ] **Passo 1: escrever o teste que falha**

`tests/transcricao.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PROMPT_TRANSCRICAO, transcritorOpenAI, type ClienteTranscricao } from "../src/whatsapp/transcricao.js";

const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]);

function cliente(respostas: Array<string | Error>) {
  const chamadas: Array<Record<string, unknown>> = [];
  const c: ClienteTranscricao = {
    audio: {
      transcriptions: {
        create: async (p) => {
          chamadas.push(p);
          const r = respostas.shift();
          if (r instanceof Error) throw r;
          return r ?? "";
        },
      },
    },
  };
  return { c, chamadas };
}

function montar(respostas: Array<string | Error>) {
  const { c, chamadas } = cliente(respostas);
  const logs: Array<Record<string, unknown>> = [];
  const pausas: number[] = [];
  const t = transcritorOpenAI(c, "whisper-1", (e) => logs.push(e), async (ms) => void pausas.push(ms));
  return { t, chamadas, logs, pausas };
}

describe("transcritorOpenAI", () => {
  it("chama o whisper-1 em português, com o prompt da loja e o arquivo com a extensão do mime", async () => {
    const { t, chamadas } = montar(["quero cinquenta canecas"]);
    expect(await t.transcrever(OGG, "audio/ogg; codecs=opus")).toBe("quero cinquenta canecas");
    expect(chamadas[0]).toMatchObject({ model: "whisper-1", language: "pt", response_format: "text", prompt: PROMPT_TRANSCRICAO });
    expect((chamadas[0].file as File).name).toBe("audio.ogg");
  });

  it("texto vazio ou só pontuação vira null", async () => {
    expect(await montar(["   "]).t.transcrever(OGG, "audio/ogg")).toBeNull();
    expect(await montar([" ... "]).t.transcrever(OGG, "audio/ogg")).toBeNull();
  });

  it.each([
    "Legendas pela comunidade Amara.org",
    "Obrigado por assistir!",
    "obrigada por assistir.",
    "Inscreva-se no canal",
    "Legenda Adriana Zanotto",
  ])("alucinação do Whisper em áudio mudo vira null: %s", async (frase) => {
    expect(await montar([frase]).t.transcrever(OGG, "audio/ogg")).toBeNull();
  });

  it("frase real com 'obrigado' passa (a comparação é do texto inteiro)", async () => {
    expect(await montar(["Obrigado, quero 20 squeezes"]).t.transcrever(OGG, "audio/ogg")).toBe("Obrigado, quero 20 squeezes");
  });

  it("3 falhas viram null, sem 4ª chamada, com pausas de 1 s e 3 s e log sem o texto", async () => {
    const { t, chamadas, logs, pausas } = montar([new Error("timeout 1"), new Error("timeout 2"), new Error("timeout 3"), "nunca"]);
    expect(await t.transcrever(OGG, "audio/ogg")).toBeNull();
    expect(chamadas).toHaveLength(3);
    expect(pausas).toEqual([1_000, 3_000]);
    expect(logs.map((l) => [l.type, l.tentativa])).toEqual([
      ["audio_tentativa_falhou", 1],
      ["audio_tentativa_falhou", 2],
      ["audio_tentativa_falhou", 3],
    ]);
    expect(JSON.stringify(logs)).not.toContain("nunca");
  });

  it("falha e depois acerta: devolve o texto da 2ª tentativa", async () => {
    const { t, chamadas } = montar([new Error("503"), "pra dia dez"]);
    expect(await t.transcrever(OGG, "audio/ogg")).toBe("pra dia dez");
    expect(chamadas).toHaveLength(2);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

Rode: `npx vitest run tests/transcricao.test.ts --poolOptions.forks.singleFork`
Esperado: FAIL, porque o módulo `../src/whatsapp/transcricao.js` não existe.

- [ ] **Passo 3: implementar**

`src/whatsapp/transcricao.ts`:

```ts
import { toFile } from "openai";
import { esperar } from "./envio.js";
import type { LogPonte } from "./log.js";

export interface Transcritor {
  /** Texto do áudio, ou null quando não deu (falha, silêncio ou alucinação conhecida). */
  transcrever(dados: Buffer, mime: string): Promise<string | null>;
}

/** O pedaço do SDK `openai` que a transcrição usa; o teste injeta um falso. */
export interface ClienteTranscricao {
  audio: { transcriptions: { create(p: Record<string, unknown>): Promise<unknown> } };
}

// O Whisper só considera os ~224 tokens finais do prompt: curto e com o vocabulário da loja
export const PROMPT_TRANSCRICAO =
  "Mensagem de voz em português do Brasil de um cliente da Presentes Especiais, loja de brindes personalizados. " +
  "Produtos comuns: camisa dry fit, caneca mágica, squeeze, garrafa térmica, ecobag, boné, caneta, chaveiro, agenda. " +
  "O cliente fala quantidades (cinquenta unidades), cores, prazos e a logo da empresa.";

const TENTATIVAS = 3;
const PAUSAS_MS = [1_000, 3_000];

const normalizar = (t: string) =>
  t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

// O Whisper inventa estas frases em áudio sem fala; compara o texto inteiro, nunca includes
const ALUCINACOES = new Set(
  ["legendas pela comunidade amara.org", "obrigado por assistir", "obrigada por assistir", "inscreva-se no canal", "legenda adriana zanotto"].map(normalizar)
);

function extensao(mime: string): string {
  if (/mpeg|mp3/.test(mime)) return "mp3";
  if (/mp4|m4a|aac/.test(mime)) return "m4a";
  return "ogg"; // o ptt do WhatsApp é Opus em Ogg
}

export function transcritorOpenAI(
  cliente: ClienteTranscricao,
  modelo: string,
  log: LogPonte,
  pausa: (ms: number) => Promise<void> = esperar
): Transcritor {
  return {
    async transcrever(dados, mime) {
      for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
        try {
          const file = await toFile(dados, `audio.${extensao(mime)}`, { type: mime.split(";")[0].trim() });
          const r = await cliente.audio.transcriptions.create({ file, model: modelo, language: "pt", response_format: "text", prompt: PROMPT_TRANSCRICAO });
          const texto = (typeof r === "string" ? r : String((r as { text?: unknown })?.text ?? "")).trim();
          const n = normalizar(texto);
          return n && !ALUCINACOES.has(n) ? texto : null;
        } catch (err) {
          log({ type: "audio_tentativa_falhou", tentativa, erro: err instanceof Error ? err.message : String(err) });
          if (tentativa < TENTATIVAS) await pausa(PAUSAS_MS[tentativa - 1]);
        }
      }
      return null;
    },
  };
}
```

No `.env.example` da raiz, logo abaixo de `OPENAI_API_KEY=sk-...`:

```
# Transcrição dos áudios do cliente (ponte). Se o Whisper não for bem, troque o modelo aqui.
TRANSCRICAO_MODELO=whisper-1
```

- [ ] **Passo 4: rodar e ver passar**

Rode: `npx vitest run tests/transcricao.test.ts --poolOptions.forks.singleFork`
Esperado: PASS, com 10 testes (o `it.each` conta 5).

- [ ] **Passo 5: commit**

```bash
git add src/whatsapp/transcricao.ts tests/transcricao.test.ts .env.example
git commit -m "feat(whatsapp): transcritor de áudio com Whisper" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 2: A ponte ouve o áudio

**Arquivos:**
- Modificar: `src/whatsapp/ponte.ts` (constantes no topo, `ObservadorPonte`, `OpcoesPonte`, `receberDoCliente` em ~:247, `mensagemDeMidia` em ~:278)
- Modificar: `tests/ponte.test.ts` e `tests/ponteRegressoes.test.ts` (troca `MSG_AUDIO` → `MSG_AUDIO_FALHOU`)
- Criar: `tests/ponteAudio.test.ts`

**Interfaces:**
- Consome: `Transcritor` (Tarefa 1).
- Produz: `MSG_AUDIO_FALHOU`; `interface MidiaObservada { id: string; telefone: string; mime: string; base64: string; transcricao: string | null; status: "OK" | "FALHOU" | "NAO_TRANSCRITO" }`; `ObservadorPonte.midia?(m: MidiaObservada): void`; `OpcoesPonte.transcritor?: Transcritor`.

- [ ] **Passo 1: escrever os testes que falham**

`tests/ponteAudio.test.ts`:

```ts
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

  it("com humano: não chama o transcritor, não vai ao agente e o CRM recebe NAO_TRANSCRITO", async () => {
    const t = transcritor("não devia");
    const { canal, agente, ponte, midias } = montar({ transcritor: t });
    await ponte.receber(canal.mensagem({ chatId: CLIENTE, texto: "assumi", deMim: true }));
    await ponte.receber(audio(canal));
    await vi.runAllTimersAsync();
    expect(t.chamadas).toBe(0);
    expect(agente.lotes).toEqual([]);
    expect(midias).toEqual([expect.objectContaining({ status: "NAO_TRANSCRITO", transcricao: null })]);
  });

  it("número fora da IA: NAO_TRANSCRITO, uma vez só mesmo varrido de novo", async () => {
    const t = transcritor("não devia");
    const { canal, agente, ponte, midias } = montar({ transcritor: t, liberados: ["5583000000000"] });
    const msg = audio(canal);
    await ponte.receber(msg);
    canal.naoLidas = [{ chatId: CLIENTE, mensagens: [msg] }];
    await ponte.varrer();
    await vi.runAllTimersAsync();
    expect(t.chamadas).toBe(0);
    expect(agente.lotes).toEqual([]);
    expect(midias).toHaveLength(1);
    expect(midias[0].status).toBe("NAO_TRANSCRITO");
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
```

Nos testes que já existem, troque o import e todos os usos de `MSG_AUDIO` por `MSG_AUDIO_FALHOU`:
- `tests/ponte.test.ts:5` e as linhas 234 e 246;
- `tests/ponteRegressoes.test.ts:6` e as linhas 120, 131 e 284.

Os áudios desses testes não têm `baixarMidia`, então o download falha e o caminho visível é igual ao de hoje, só que com a mensagem nova. Renomeie também o título do teste de `ponte.test.ts` "áudio: resposta fixa, não vai ao agente, marca como lida" para "áudio que não baixa: pede o texto, não vai ao agente, marca como lida".

- [ ] **Passo 2: rodar e ver falhar**

Rode: `npx vitest run tests/ponteAudio.test.ts tests/ponte.test.ts tests/ponteRegressoes.test.ts --poolOptions.forks.singleFork`
Esperado: FAIL, porque `MSG_AUDIO_FALHOU`, `MidiaObservada` e `transcritor` ainda não existem.

- [ ] **Passo 3: implementar em `src/whatsapp/ponte.ts`**

Imports, junto aos outros:

```ts
import type { Transcritor } from "./transcricao.js";
```

Troque a constante `MSG_AUDIO` por:

```ts
export const MSG_AUDIO_FALHOU = "Não consegui ouvir seu áudio direito. Pode me mandar por escrito?";
```

Depois de `MensagemObservada`:

```ts
/** O áudio do cliente, com o resultado da transcrição, para o CRM guardar e tocar. */
export interface MidiaObservada {
  id: string;
  telefone: string;
  mime: string;
  base64: string;
  transcricao: string | null;
  status: "OK" | "FALHOU" | "NAO_TRANSCRITO";
}
```

Em `ObservadorPonte`:

```ts
  /** O áudio de uma mensagem já observada; chega depois dela. */
  midia?(m: MidiaObservada): void;
```

Em `OpcoesPonte`:

```ts
  /** Sem transcritor, todo áudio com a IA é tratado como falha de transcrição. */
  transcritor?: Transcritor;
```

Campo novo da classe, junto de `concluidos`:

```ts
  private readonly audiosObservados = new ConjuntoLimitado(2_000);
```

Em `receberDoCliente`, o áudio sai antes do `iaAtende` e deixa o bloco do `ignorada`:

```ts
  private async receberDoCliente(m: MensagemRecebida): Promise<void> {
    if (!m.direta || !m.telefone || this.concluidos.has(m.id) || this.reservados.has(m.id)) return;
    const telefone = m.telefone;
    if (m.tipo === "audio") return this.receberAudio(telefone, m);
    if (!this.iaAtende(telefone)) return;

    if (m.tipo === "ignorada") {
      this.reservados.add(m.id);
      try {
        this.concluir([m.id]);
        if (this.podeMarcarLida(telefone, false)) await this.marcarComoLida(m.chatId);
      } finally {
        this.reservados.delete(m.id);
      }
      return;
    }
    // ... o resto (midia e texto) fica como está
```

Métodos novos, logo depois de `receberDoCliente`:

```ts
  /** Todo áudio do cliente vai ao CRM uma vez; só com a IA atendendo ele é transcrito e entra no lote. */
  private async receberAudio(telefone: string, m: MensagemRecebida): Promise<void> {
    const comIa = this.iaAtende(telefone) && this.atendimento.modo(telefone) === "ia";
    if (!comIa) {
      if (this.opcoes.observador?.midia && !this.audiosObservados.has(m.id)) {
        this.audiosObservados.add(m.id);
        const midia = await this.baixar(m);
        if (midia) this.observarMidia(telefone, m.id, midia, null, "NAO_TRANSCRITO");
      }
      if (!this.iaAtende(telefone)) return;
      this.concluir([m.id]);
      if (this.podeMarcarLida(telefone, false)) await this.marcarComoLida(m.chatId);
      return;
    }

    // Reservado antes do download para o áudio não chegar depois do texto que veio atrás dele
    if (!this.fila.reservar(telefone, m.chatId, m.id)) return;
    const midia = await this.baixar(m);
    const texto = midia && this.opcoes.transcritor ? await this.opcoes.transcritor.transcrever(Buffer.from(midia.base64, "base64"), midia.mime) : null;
    if (midia && !this.audiosObservados.has(m.id)) {
      this.audiosObservados.add(m.id);
      this.observarMidia(telefone, m.id, midia, texto, texto ? "OK" : "FALHOU");
    }
    if (texto) {
      this.fila.preencher(telefone, m.id, { id: m.id, timestamp: m.timestamp, texto: neutralizarMarcadores(texto).slice(0, LIMITE_TEXTO), ...nomeDoContato(m) });
      return;
    }
    this.fila.cancelar(telefone, m.id);
    this.reservados.add(m.id);
    try {
      // Aviso que não sai: não conclui, e a varredura tenta de novo
      if (!(await this.envio.paraCliente(telefone, m.chatId, MSG_AUDIO_FALHOU))) return;
      this.concluir([m.id]);
      if (this.podeMarcarLida(telefone, false)) await this.marcarComoLida(m.chatId);
    } finally {
      this.reservados.delete(m.id);
    }
  }

  /** Baixa a mídia no prazo e no teto; null quando não deu (o motivo vai ao log). */
  private async baixar(m: MensagemRecebida): Promise<MidiaBaixada | null> {
    if (m.bytesDeclarados !== undefined && m.bytesDeclarados > TAMANHO_MAXIMO_BYTES) return null;
    try {
      return await comPrazo(m.baixarMidia?.() ?? Promise.resolve(null), PRAZO_DOWNLOAD_MS, null);
    } catch (err) {
      this.log({ type: "midia_nao_baixou", id: m.id, erro: String(err) });
      return null;
    }
  }

  private observarMidia(telefone: string, id: string, midia: MidiaBaixada, transcricao: string | null, status: MidiaObservada["status"]): void {
    try {
      this.opcoes.observador?.midia?.({ id, telefone, mime: midia.mime, base64: midia.base64, transcricao, status });
    } catch (err) {
      this.log({ type: "observador_falhou", erro: String(err) });
    }
  }
```

Em `mensagemDeMidia`, troque o bloco do download (o `let midia` com o `try/catch`) por uma linha. A checagem de tamanho continua antes, porque ela dá uma recusa específica:

```ts
    const midia = await this.baixar(m);
```

- [ ] **Passo 4: rodar e ver passar**

Rode: `npx vitest run tests/ponteAudio.test.ts tests/ponte.test.ts tests/ponteRegressoes.test.ts tests/observadorPonte.test.ts --poolOptions.forks.singleFork`
Esperado: PASS. Depois rode `npx tsc --noEmit` (limpo) e a suíte inteira, `npx vitest run --poolOptions.forks.singleFork`, também verde.

- [ ] **Passo 5: commit**

```bash
git add src/whatsapp/ponte.ts tests/ponteAudio.test.ts tests/ponte.test.ts tests/ponteRegressoes.test.ts
git commit -m "feat(whatsapp): a ponte transcreve o áudio do cliente e manda ao CRM" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 3: Observador do CRM e ligação na partida

**Arquivos:**
- Modificar: `src/whatsapp/crm.ts` (tipo `Item`, método `midia`)
- Modificar: `src/whatsapp/index.ts` (cria o transcritor e passa à `Ponte`)
- Criar: `tests/observadorCrm.test.ts`

**Interfaces:**
- Consome: `MidiaObservada` (Tarefa 2), `transcritorOpenAI` e `ClienteTranscricao` (Tarefa 1).
- Produz: `ObservadorCrm.midia(m: MidiaObservada): void`, que faz POST em `${url}/api/integracao/midias` com o corpo `MidiaObservada`.

- [ ] **Passo 1: escrever o teste que falha**

`tests/observadorCrm.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservadorCrm } from "../src/whatsapp/crm.js";

describe("ObservadorCrm", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("o áudio vai a /midias depois da mensagem do mesmo id, na mesma fila", async () => {
    const rotas: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        rotas.push(`${url.split("/").pop()}:${JSON.parse(String(init.body)).id}`);
        return new Response("{}", { status: 200 });
      })
    );
    const obs = new ObservadorCrm("http://crm", "s".repeat(16), async () => null, () => {});
    obs.mensagem({ id: "a1", telefone: "5583999990000", autor: "CLIENTE", tipo: "audio", texto: "", timestamp: "2026-11-18T10:00:00Z" });
    obs.midia({ id: "a1", telefone: "5583999990000", mime: "audio/ogg", base64: "T2dnUw==", transcricao: "oi", status: "OK" });
    await vi.waitFor(() => expect(rotas).toEqual(["mensagens:a1", "midias:a1"]));
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

Rode: `npx vitest run tests/observadorCrm.test.ts --poolOptions.forks.singleFork`
Esperado: FAIL com "obs.midia is not a function".

- [ ] **Passo 3: implementar**

Em `src/whatsapp/crm.ts`, troque o import e o tipo `Item`:

```ts
import type { MensagemObservada, MidiaObservada, ObservadorPonte } from "./ponte.js";
```

```ts
type Item =
  | { rota: "mensagens"; corpo: MensagemObservada & { nome?: string } }
  | { rota: "midias"; corpo: MidiaObservada }
  | { rota: "conversas"; telefone: string };
```

E acrescente o método depois de `mensagem`:

```ts
  /**
   * shortcut: os bytes do áudio ficam na memória da fila até o CRM aceitar; se a ponte reiniciar com o CRM
   * fora, o áudio se perde (a transcrição já foi para a Lia). Trocar por fila em disco quando a ponte for para a nuvem.
   */
  midia(m: MidiaObservada): void {
    this.enfileirar({ rota: "midias", corpo: m });
  }
```

O `enviar` já trata a rota `midias`, porque cai no `else { corpo = item.corpo; }`.

Em `src/whatsapp/index.ts`, imports:

```ts
import OpenAI from "openai";
import { transcritorOpenAI, type ClienteTranscricao } from "./transcricao.js";
```

Antes do `new Ponte(`:

```ts
  const transcritor = config.openaiApiKey
    ? transcritorOpenAI(
        new OpenAI({ apiKey: config.openaiApiKey, timeout: 60_000, maxRetries: 0 }) as unknown as ClienteTranscricao,
        process.env.TRANSCRICAO_MODELO || "whisper-1",
        log
      )
    : undefined;
```

Nas opções da `Ponte`, depois de `estadoInicial,`:

```ts
      ...(transcritor ? { transcritor } : {}),
```

- [ ] **Passo 4: rodar e ver passar**

Rode: `npx vitest run tests/observadorCrm.test.ts --poolOptions.forks.singleFork` e `npx tsc --noEmit`
Esperado: PASS e `tsc` limpo.

- [ ] **Passo 5: commit**

```bash
git add src/whatsapp/crm.ts src/whatsapp/index.ts tests/observadorCrm.test.ts
git commit -m "feat(whatsapp): áudio vai ao CRM e o transcritor liga na partida" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 4: CRM recebe e guarda o áudio

Todos os comandos desta tarefa rodam em `crm/`.

**Arquivos:**
- Criar: `crm/db/migrations/007_audio.sql`
- Modificar: `crm/src/lib/arquivos.ts` (`detectarAudio`, `MIME_AUDIO`, `chaveSegura`)
- Criar: `crm/src/app/api/integracao/midias/route.ts`
- Modificar: `crm/tests/arquivos.test.ts`
- Criar: `crm/tests/midias.test.ts`

**Interfaces:**
- Consome: o corpo `MidiaObservada` da ponte (Tarefa 3).
- Produz: as colunas `messages.media_key`, `media_mime`, `media_bytes`, `transcription` e `transcription_status`; `detectarAudio(bytes: Uint8Array): TipoAudio | null`; `MIME_AUDIO: Record<TipoAudio, string>`; a chave `audios/<lead_id>/<message_id>.<ext>`.

- [ ] **Passo 1: escrever os testes que falham**

Em `crm/tests/arquivos.test.ts`, acrescente (e junte `detectarAudio` e `chaveSegura` ao import de `@/lib/arquivos`):

```ts
describe("detectarAudio", () => {
  const b = (...partes: Array<string | number[]>) => Buffer.concat(partes.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));
  it("reconhece ogg, mp3 (ID3 e frame sync) e m4a pelos primeiros bytes", () => {
    expect(detectarAudio(b("OggS", [0, 0, 0, 0]))).toBe("ogg");
    expect(detectarAudio(b("ID3", [3, 0, 0]))).toBe("mp3");
    expect(detectarAudio(b([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3");
    expect(detectarAudio(b([0, 0, 0, 0x20], "ftypM4A "))).toBe("m4a");
  });
  it("PNG e JPEG não são áudio, e áudio não é imagem para o design", () => {
    expect(detectarAudio(b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBeNull();
    expect(detectarAudio(b([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(detectarTipo(b("OggS", [0, 0, 0, 0]))).toBeNull();
  });
  it("chaveSegura aceita audios/ e continua recusando ..", () => {
    expect(chaveSegura("audios/lead/msg.ogg")).toBe(true);
    expect(chaveSegura("audios/../x")).toBe(false);
    expect(chaveSegura("outra/x.ogg")).toBe(false);
  });
});
```

`crm/tests/midias.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { one, query } from "@/lib/db";
import { armazem } from "@/lib/arquivos";
import { POST } from "@/app/api/integracao/midias/route";
import { criarLead, limparBanco } from "./banco";

const SEGREDO = "segredo-da-integracao-123";
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]).toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
const TEL = "5583999990000";

beforeAll(() => {
  process.env.CRM_INTEGRATION_SECRET = SEGREDO;
  process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "arq-"));
});

const pedir = (corpo: object, segredo = SEGREDO) =>
  POST(new Request("http://x/api/integracao/midias", { method: "POST", headers: { "content-type": "application/json", "x-crm-secret": segredo }, body: JSON.stringify(corpo) }));

async function mensagemDeAudio(): Promise<{ leadId: string; msgId: string }> {
  const leadId = await criarLead({ phone: TEL });
  const m = await one<{ id: string }>(
    "INSERT INTO messages (lead_id, external_id, author, body, sent_at, source, kind) VALUES ($1, 'wa-1', 'CLIENTE', '🎤 Áudio', NOW(), 'WHATSAPP', 'audio') RETURNING id",
    [leadId]
  );
  return { leadId, msgId: m!.id };
}

const corpo = (extra: object = {}) => ({ id: "wa-1", telefone: TEL, mime: "audio/ogg", base64: OGG, transcricao: "quero canecas", status: "OK", ...extra });

describe("POST /api/integracao/midias", () => {
  beforeEach(limparBanco);

  it("401 sem o segredo", async () => {
    expect((await pedir(corpo(), "errado-errado-errado")).status).toBe(401);
  });

  it("404 sem a mensagem", async () => {
    await criarLead({ phone: TEL });
    expect((await pedir(corpo())).status).toBe(404);
  });

  it("422 com bytes que não são áudio", async () => {
    await mensagemDeAudio();
    expect((await pedir(corpo({ base64: PNG }))).status).toBe(422);
  });

  it("transcricao com status diferente de OK é recusada", async () => {
    await mensagemDeAudio();
    expect((await pedir(corpo({ status: "FALHOU" }))).status).toBe(400);
  });

  it("200: grava no armazém e nas cinco colunas; o segundo envio não regrava", async () => {
    const { leadId, msgId } = await mensagemDeAudio();
    expect((await pedir(corpo())).status).toBe(200);
    const m = await one<Record<string, unknown>>("SELECT media_key, media_mime, media_bytes, transcription, transcription_status FROM messages WHERE id = $1", [msgId]);
    expect(m).toEqual({ media_key: `audios/${leadId}/${msgId}.ogg`, media_mime: "audio/ogg", media_bytes: 64, transcription: "quero canecas", transcription_status: "OK" });
    expect((await armazem().ler(m!.media_key as string)).subarray(0, 4).toString()).toBe("OggS");

    expect((await pedir(corpo({ transcricao: "outra coisa" }))).status).toBe(200);
    const [{ t }] = await query<{ t: string }>("SELECT transcription AS t FROM messages WHERE id = $1", [msgId]);
    expect(t).toBe("quero canecas");
  });

  it("NAO_TRANSCRITO grava sem texto", async () => {
    const { msgId } = await mensagemDeAudio();
    expect((await pedir(corpo({ transcricao: null, status: "NAO_TRANSCRITO" }))).status).toBe(200);
    const [r] = await query<{ s: string; t: string | null }>("SELECT transcription_status AS s, transcription AS t FROM messages WHERE id = $1", [msgId]);
    expect(r).toEqual({ s: "NAO_TRANSCRITO", t: null });
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

Rode (em `crm/`): `npx vitest run tests/arquivos.test.ts tests/midias.test.ts`
Esperado: FAIL, porque `detectarAudio` e a rota `midias` não existem.

- [ ] **Passo 3: implementar**

`crm/db/migrations/007_audio.sql`:

```sql
-- Áudio do cliente (Fase 4): o arquivo fica no Armazem; a transcrição numa coluna própria, fora do body
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_key TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_bytes INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription_status TEXT
  CHECK (transcription_status IN ('OK', 'FALHOU', 'NAO_TRANSCRITO'));
```

Em `crm/src/lib/arquivos.ts`, depois de `ehAnalisavel`:

```ts
export type TipoAudio = "ogg" | "mp3" | "m4a";
export const MIME_AUDIO: Record<TipoAudio, string> = { ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4" };

/** Áudio pelos primeiros bytes. Fora do detectarTipo para o design não aceitar nota de voz como referência. */
export function detectarAudio(bytes: Uint8Array): TipoAudio | null {
  const ascii = (i: number, s: string) => [...s].every((c, k) => bytes[i + k] === c.charCodeAt(0));
  if (ascii(0, "OggS")) return "ogg"; // o ptt do WhatsApp (Opus)
  if (ascii(4, "ftyp")) return "m4a";
  if (ascii(0, "ID3") || (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)) return "mp3";
  return null;
}
```

E troque `chaveSegura`:

```ts
export const chaveSegura = (chave: string) =>
  (chave.startsWith("design/") || chave.startsWith("audios/")) && !chave.includes("..") && !chave.includes("\\");
```

`crm/src/app/api/integracao/midias/route.ts`:

```ts
import { NextResponse } from "next/server";
import { jsonError, readJson, serverError } from "@/lib/access";
import { LIMITE_BYTES, MIME_AUDIO, armazem, detectarAudio } from "@/lib/arquivos";
import { one, query } from "@/lib/db";
import { integrationAuthorized } from "@/lib/integration";
import { phoneVariants } from "@/lib/orders";

const STATUS = ["OK", "FALHOU", "NAO_TRANSCRITO"] as const;

/** A ponte manda o áudio do cliente (e a transcrição, quando houve) depois da mensagem "🎤 Áudio" do mesmo id. */
export async function POST(request: Request) {
  if (!integrationAuthorized(request)) return jsonError("Não autorizado.", 401);
  const b = await readJson(request);
  const id = typeof b.id === "string" ? b.id.slice(0, 200) : "";
  const telefone = typeof b.telefone === "string" ? b.telefone.replace(/\D/g, "") : "";
  const status = STATUS.find((s) => s === b.status);
  const transcricao = b.transcricao ?? null;
  if (!id || telefone.length < 10 || !status || typeof b.base64 !== "string") {
    return jsonError("id, telefone, base64 e status são obrigatórios.", 400);
  }
  if (transcricao !== null && (typeof transcricao !== "string" || status !== "OK")) {
    return jsonError("transcricao só vem com status OK.", 400);
  }
  const bytes = Buffer.from(b.base64, "base64");
  if (bytes.length > LIMITE_BYTES) return jsonError("Áudio maior que 16 MB.", 413);
  // O tipo vem dos bytes, nunca do mime declarado
  const tipo = detectarAudio(bytes);
  if (!tipo) return jsonError("O arquivo não é áudio (ogg, mp3 ou m4a).", 422);
  try {
    const msg = await one<{ id: string; lead_id: string; media_key: string | null }>(
      `SELECT m.id, m.lead_id, m.media_key FROM messages m JOIN leads l ON l.id = m.lead_id
       WHERE l.phone = ANY($1) AND m.external_id = $2 AND m.source = 'WHATSAPP' LIMIT 1`,
      [phoneVariants(telefone), id]
    );
    if (!msg) return jsonError("Mensagem não encontrada.", 404);
    // A ponte repete o envio quando não sabe se chegou: não regrava
    if (msg.media_key) return NextResponse.json({ ok: true });
    const chave = `audios/${msg.lead_id}/${msg.id}.${tipo}`;
    await armazem().salvar(chave, bytes, MIME_AUDIO[tipo]);
    await query(
      "UPDATE messages SET media_key = $2, media_mime = $3, media_bytes = $4, transcription = $5, transcription_status = $6 WHERE id = $1",
      [msg.id, chave, MIME_AUDIO[tipo], bytes.length, typeof transcricao === "string" ? transcricao.slice(0, 4000) : null, status]
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err, "integração de mídias");
  }
}
```

- [ ] **Passo 4: rodar e ver passar**

Rode (em `crm/`): `npx vitest run tests/arquivos.test.ts tests/midias.test.ts`, depois `npx tsc --noEmit` e `npx vitest run` (a suíte inteira do CRM).
Esperado: tudo PASS e `tsc` limpo. O `design.test.ts` continua verde: o design segue recusando áudio.

- [ ] **Passo 5: commit**

```bash
git add crm/db/migrations/007_audio.sql crm/src/lib/arquivos.ts crm/src/app/api/integracao/midias/route.ts crm/tests/arquivos.test.ts crm/tests/midias.test.ts
git commit -m "feat(crm): recebe e guarda o áudio do cliente com a transcrição" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 5: Player no painel do lead

Todos os comandos desta tarefa rodam em `crm/`.

**Arquivos:**
- Modificar: `crm/src/app/api/design/arquivo/route.ts` (serve áudio e responde `Range`)
- Criar: `crm/src/app/api/leads/[id]/messages/[messageId]/audio/route.ts`
- Modificar: `crm/src/app/api/leads/[id]/route.ts:21-22` (colunas novas na query de mensagens)
- Modificar: `crm/src/lib/types.ts:87-95` (`Message`)
- Modificar: `crm/src/components/crm/LeadPanel.tsx` (`Conversation` em ~:332 e o uso em ~:118)
- Criar: `crm/tests/audioLead.test.ts`

**Interfaces:**
- Consome: as colunas da Tarefa 4, `detectarAudio` e `MIME_AUDIO`.
- Produz: `GET /api/leads/{id}/messages/{messageId}/audio` → 302 para a URL temporária, ou 404. `Message` ganha `transcription?: string | null`, `transcription_status?: string | null` e `has_media?: boolean`.

- [ ] **Passo 1: escrever os testes que falham**

`crm/tests/audioLead.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { one, query } from "@/lib/db";
import { signSession } from "@/lib/auth/token";
import { armazem } from "@/lib/arquivos";
import { GET as ouvir } from "@/app/api/leads/[id]/messages/[messageId]/audio/route";
import { GET as arquivo } from "@/app/api/design/arquivo/route";
import { criarLead, criarUsuario, limparBanco } from "./banco";

let token = "";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: token }) }) }));

beforeAll(() => {
  process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "arq-"));
});

async function entrarComo(role: "ADMIN" | "COLABORADOR"): Promise<string> {
  const id = await criarUsuario({ role });
  await query("UPDATE users SET must_change_password = false WHERE id = $1", [id]);
  const { v } = (await one<{ v: number }>("SELECT session_version AS v FROM users WHERE id = $1", [id]))!;
  token = await signSession({ sub: id, role, v });
  return id;
}

const AUDIO = Buffer.concat([Buffer.from("OggS"), Buffer.from(Array.from({ length: 96 }, (_, i) => i))]);

async function audioDoLead(assignedTo: string | null, comMidia = true): Promise<{ leadId: string; msgId: string; chave: string }> {
  const leadId = await criarLead({ assignedTo });
  const m = await one<{ id: string }>(
    "INSERT INTO messages (lead_id, external_id, author, body, sent_at, source, kind) VALUES ($1, 'wa-a', 'CLIENTE', '🎤 Áudio', NOW(), 'WHATSAPP', 'audio') RETURNING id",
    [leadId]
  );
  const chave = `audios/${leadId}/${m!.id}.ogg`;
  if (comMidia) {
    await armazem().salvar(chave, AUDIO, "audio/ogg");
    await query("UPDATE messages SET media_key = $2, media_mime = 'audio/ogg', transcription_status = 'NAO_TRANSCRITO' WHERE id = $1", [m!.id, chave]);
  }
  return { leadId, msgId: m!.id, chave };
}

const pedir = (leadId: string, msgId: string) =>
  ouvir(new Request(`http://crm.local/api/leads/${leadId}/messages/${msgId}/audio`), { params: Promise.resolve({ id: leadId, messageId: msgId }) });

describe("áudio do lead", () => {
  beforeEach(limparBanco);

  it("302 para a URL temporária, para quem vê o lead", async () => {
    const eu = await entrarComo("COLABORADOR");
    const { leadId, msgId } = await audioDoLead(eu);
    const r = await pedir(leadId, msgId);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/api/design/arquivo?chave=audios%2F");
  });

  it("404 para vendedor fora do lead", async () => {
    await entrarComo("COLABORADOR");
    const outro = await criarUsuario({ role: "COLABORADOR" });
    const { leadId, msgId } = await audioDoLead(outro);
    expect((await pedir(leadId, msgId)).status).toBe(404);
  });

  it("404 para mensagem sem áudio guardado", async () => {
    await entrarComo("ADMIN");
    const { leadId, msgId } = await audioDoLead(null, false);
    expect((await pedir(leadId, msgId)).status).toBe(404);
  });

  describe("rota de disco", () => {
    async function urlAssinada(): Promise<string> {
      await entrarComo("ADMIN");
      const { chave } = await audioDoLead(null);
      return `http://crm.local${await armazem().urlTemporaria(chave)}`;
    }

    it("serve o áudio inteiro com o tipo certo e Accept-Ranges", async () => {
      const r = await arquivo(new Request(await urlAssinada()));
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("audio/ogg");
      expect(r.headers.get("accept-ranges")).toBe("bytes");
      expect(Buffer.from(await r.arrayBuffer())).toEqual(AUDIO);
    });

    it("Range: 206 com o pedaço e Content-Range", async () => {
      const r = await arquivo(new Request(await urlAssinada(), { headers: { range: "bytes=10-19" } }));
      expect(r.status).toBe(206);
      expect(r.headers.get("content-range")).toBe(`bytes 10-19/${AUDIO.length}`);
      expect(Buffer.from(await r.arrayBuffer())).toEqual(AUDIO.subarray(10, 20));
    });

    it("Range aberto e sufixo", async () => {
      const url = await urlAssinada();
      expect(Buffer.from(await (await arquivo(new Request(url, { headers: { range: "bytes=90-" } }))).arrayBuffer())).toEqual(AUDIO.subarray(90));
      expect(Buffer.from(await (await arquivo(new Request(url, { headers: { range: "bytes=-5" } }))).arrayBuffer())).toEqual(AUDIO.subarray(AUDIO.length - 5));
    });

    it("Range além do fim: 416; Range malformado: o arquivo inteiro", async () => {
      const url = await urlAssinada();
      const fora = await arquivo(new Request(url, { headers: { range: "bytes=500-600" } }));
      expect(fora.status).toBe(416);
      expect(fora.headers.get("content-range")).toBe(`bytes */${AUDIO.length}`);
      expect((await arquivo(new Request(url, { headers: { range: "pedaço=1-2" } }))).status).toBe(200);
    });
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

Rode (em `crm/`): `npx vitest run tests/audioLead.test.ts`
Esperado: FAIL, porque a rota de áudio não existe e a de disco responde 415 para ogg.

- [ ] **Passo 3: implementar**

`crm/src/app/api/design/arquivo/route.ts`. No import, acrescente `MIME_AUDIO` e `detectarAudio`. Do `const tipo` até o fim, o trecho fica:

```ts
  const tipo = detectarTipo(bytes);
  const audio = tipo ? null : detectarAudio(bytes);
  if (!tipo && !audio) return jsonError("Arquivo inválido.", 415);
  const headers: Record<string, string> = {
    "Content-Type": tipo ? MIME[tipo] : MIME_AUDIO[audio!],
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=600",
    "Accept-Ranges": "bytes",
  };
  // SVG pode carregar script: nunca inline
  if (tipo === "svg" || tipo === "pdf") headers["Content-Disposition"] = `attachment; filename="${chave.split("/").pop()}"`;
  if (tipo === "svg") headers["Content-Security-Policy"] = "sandbox";

  // O <audio> pede pedaços (Range) para avançar; sem 206 o player não pula. Range malformado: arquivo inteiro
  const faixa = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (faixa && (faixa[1] || faixa[2])) {
    const total = bytes.length;
    const inicio = faixa[1] ? Number(faixa[1]) : Math.max(0, total - Number(faixa[2]));
    const fim = faixa[1] && faixa[2] ? Math.min(Number(faixa[2]), total - 1) : total - 1;
    if (inicio >= total || inicio > fim) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    return new Response(new Uint8Array(bytes.subarray(inicio, fim + 1)), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${inicio}-${fim}/${total}` },
    });
  }
  return new Response(new Uint8Array(bytes), { headers });
}
```

`crm/src/app/api/leads/[id]/messages/[messageId]/audio/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getLeadForUser, isUuid, jsonError, requireUser, serverError } from "@/lib/access";
import { armazem } from "@/lib/arquivos";
import { one } from "@/lib/db";

type Context = { params: Promise<{ id: string; messageId: string }> };

/** O player do painel: redireciona para a URL temporária do áudio, só para quem vê o lead. */
export async function GET(request: Request, { params }: Context) {
  const guard = await requireUser({ allowDesigner: true });
  if (guard.error) return guard.error;
  const { id, messageId } = await params;
  try {
    // Lead fora do escopo responde 404, como o GET do lead: não revela que ele existe
    const lead = await getLeadForUser(id, guard.user);
    if (!lead || !isUuid(messageId)) return jsonError("Áudio não encontrado.", 404);
    const m = await one<{ media_key: string | null }>("SELECT media_key FROM messages WHERE id = $1 AND lead_id = $2", [messageId, id]);
    if (!m?.media_key) return jsonError("Áudio não encontrado.", 404);
    return NextResponse.redirect(new URL(await armazem().urlTemporaria(m.media_key), request.url), 302);
  } catch (err) {
    return serverError(err, "áudio do lead");
  }
}
```

Em `crm/src/app/api/leads/[id]/route.ts`, a query de mensagens passa a ser:

```ts
        `SELECT m.id, m.author, u.name AS sent_by_name, m.body, m.sent_at, m.kind,
                m.transcription, m.transcription_status, (m.media_key IS NOT NULL) AS has_media
         FROM messages m LEFT JOIN users u ON u.id = m.sent_by WHERE m.lead_id = $1 ORDER BY m.sent_at ASC LIMIT 500`,
```

Em `crm/src/lib/types.ts`, dentro de `Message`, depois de `kind?: string;`:

```ts
  /** Só no áudio do cliente (Fase 4). A chave do arquivo não vai ao navegador. */
  transcription?: string | null;
  transcription_status?: "OK" | "FALHOU" | "NAO_TRANSCRITO" | null;
  has_media?: boolean;
```

Em `crm/src/components/crm/LeadPanel.tsx`, no uso (~:118):

```tsx
        {tab === "conversa" && <Conversation leadId={lead.id} messages={data.messages} />}
```

A assinatura do componente:

```tsx
function Conversation({ leadId, messages }: { leadId: string; messages: Message[] }) {
```

E, no balão, troque `<p className="whitespace-pre-wrap break-words">{m.body}</p>` por:

```tsx
                {m.kind === "audio" && m.has_media ? (
                  <>
                    {/* preload none: abrir o lead não baixa todos os áudios */}
                    <audio controls preload="none" src={`/api/leads/${leadId}/messages/${m.id}/audio`} className="max-w-full" />
                    {m.transcription_status === "OK" && m.transcription && (
                      <p className="mt-1 whitespace-pre-wrap break-words italic opacity-80">Transcrição: {m.transcription}</p>
                    )}
                    {m.transcription_status === "FALHOU" && <p className="mt-1 text-[12px] opacity-70">Transcrição falhou: ouça o áudio</p>}
                  </>
                ) : (
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                )}
```

- [ ] **Passo 4: rodar e ver passar**

Rode (em `crm/`): `npx vitest run tests/audioLead.test.ts`, depois `npx tsc --noEmit` e `npx vitest run`.
Esperado: tudo PASS e `tsc` limpo.

- [ ] **Passo 5: commit**

```bash
git add "crm/src/app/api/design/arquivo/route.ts" "crm/src/app/api/leads/[id]/messages/[messageId]/audio/route.ts" "crm/src/app/api/leads/[id]/route.ts" crm/src/lib/types.ts crm/src/components/crm/LeadPanel.tsx crm/tests/audioLead.test.ts
git commit -m "feat(crm): player e transcrição do áudio no painel do lead" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 6: Verificação de ponta a ponta

Sem código novo. O que falhar aqui vira correção, com teste, num commit `fix(...)` separado.

- [ ] **Passo 1: suítes e tipos**

Na raiz: `npx tsc --noEmit` e `npx vitest run --poolOptions.forks.singleFork`. Em `crm/`: `npx tsc --noEmit` e `npx vitest run`. Esperado: tudo verde. Anote os totais de testes.

- [ ] **Passo 2: evals, uma rodada de 3**

`BRINDEME_MODE=mock npx tsx evals/runEvals.ts --rodadas 3`. Esperado: o mesmo placar da junção (343/386, 18/11), com as falhas já conhecidas (04, 05, 06 instável, 16, 17, 39, 40, 43–46). Nenhum eval muda nesta fase.

- [ ] **Passo 3: migration no CRM local**

Em `crm/`, com o `.env` apontando para `127.0.0.1:5440/crm`: `npm run db:migrate`. Esperado: aplica `007_audio.sql`. **Nunca contra o Neon do CRM** (o do Dudu, com leads reais).

- [ ] **Passo 4: fumaça com o João**

Suba a stack como na fumaça de 18/11: API na 3031, sobre o Neon do agente, e `npm run whatsapp:ponte` com a sessão do Módulo Design. Antes, confira se o `agente.modo_lia` está em modo teste. O CRM (3200) e o worker ficam locais. Reinicie o CRM, para ele pegar a rota nova. Pelo número de teste do João, nesta ordem:
1. um áudio com quantidade e nome de produto ("quero cinquenta canecas mágicas pra dia dez"): a Lia responde como se fosse texto, e o painel do lead mostra o player e a "Transcrição:";
2. um áudio com barulho de fundo;
3. um áudio mudo (só silêncio): `MSG_AUDIO_FALHOU` e "Transcrição falhou: ouça o áudio" no CRM;
4. com a conversa em humano (mande algo do chip), um áudio: o player sem texto, e a Lia calada.

Confira no `logs/ponte.jsonl` que nenhum evento leva texto transcrito. Dê play e avance no meio do áudio, para testar o Range.

- [ ] **Passo 5: registrar**

Anote o resultado na seção "Onde paramos" da nota do cofre e na memória do agente. Sem push.

## Autorrevisão contra a spec

- §5.1 transcritor → Tarefa 1. §5.2 fluxo → Tarefa 2. §5.3 observador → Tarefa 3. §6.1 migration, §6.2 tipos e §6.3 rota de mídias → Tarefa 4. §6.4 rota de áudio e Range, §6.5 painel → Tarefa 5. §7 testes → Tarefas 1–5, evals e dogfooding → Tarefa 6. §8 privacidade → restrições globais e Tarefa 6.
- Desvios da spec listados acima, com o motivo de cada um (detector separado, chave `audios/`, 404, uma vez só, `midia?` opcional).
