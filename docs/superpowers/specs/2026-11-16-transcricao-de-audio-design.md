# Transcrição de áudio: a Lia ouve, o CRM toca

> Spec de 16/11/2026. Fonte: a task do ClickUp "Transc de Áudio" (https://app.clickup.com/t/wdp7exb7pk, Luis,
> 04/11/2026). É a Fase 4 do roteiro (0 preço, 1 banco, 2 busca semântica, 3 Módulo Design, 4 áudio, 5 validação).
> O João toca o plano e a implementação. O plano vai em `docs/superpowers/plans/`.

## 1. O que é, em uma história

O cliente manda um áudio de 20 segundos: "oi, queria cinquenta canecas mágicas com a logo da empresa, pra dia
dez". Com a IA no atendimento, a ponte baixa o áudio, transcreve com o Whisper e entrega o texto à Lia no mesmo
lote das mensagens digitadas. A Lia responde como se o cliente tivesse escrito. O áudio e a transcrição vão para o
CRM, onde o vendedor abre o lead, vê o texto e pode dar play no áudio.

Se a conversa está com um atendente humano, nada é transcrito: o áudio vai para o CRM e o atendente ouve pelo
player.

## 2. Escopo

Dentro:
- transcrição na ponte com `whisper-1`, só quando a IA atende a conversa;
- envio do áudio ao CRM em qualquer modo, com o resultado da transcrição;
- armazenamento do áudio no `Armazem` do Módulo Design;
- player e transcrição no painel do lead.

Fora:
- benchmark entre modelos (o João decidiu em 16/11: se o Whisper não for bem, troca-se o modelo pelo `.env`);
- Deepgram;
- marcar para a Lia que o texto veio de áudio (exigiria mudar o prompt e rodar A/B nos evals);
- mandar ao CRM as imagens que hoje ficam no disco da ponte (a rota nova serve para isso depois, mas não nesta fase);
- áudio enviado pela Lia ou pelo atendente;
- duração, forma de onda ou velocidade de reprodução no player.

## 3. Decisões (16/11, João)

| # | Decisão |
|---|---|
| D1 | O player entra nesta fase, e o áudio vai para o `Armazem` (`crm/src/lib/arquivos.ts`) que o Módulo Design cria. |
| D2 | Modelo `whisper-1`, o mesmo do LembreMe, com `language: 'pt'` e um `prompt` com o vocabulário da loja. Sem benchmark. |
| D3 | Transcreve só com a IA no atendimento. Com humano, o CRM mostra o player sem texto. |
| D4 | Falha: 3 tentativas. Depois disso, com a IA no atendimento, a Lia manda uma mensagem fixa pedindo o texto. O erro vai só para o log. O CRM mostra o player com o aviso "transcrição falhou". |
| D5 | A ponte transcreve, o CRM guarda (abordagem 1). A Lia nunca espera o CRM. |
| D6 | A Lia recebe texto puro, sem marcação. O prompt dela não muda. |

## 4. Dependência e branches

- O `Armazem` (`armazem()`, `salvar`, `ler`, `urlTemporaria`) e o `detectarTipo` nascem na entrega 1 do Módulo
  Design, branch `quadro-de-design` (spec `docs/superpowers/specs/2026-11-15-modulo-design-design.md`, seção 6).
  **A implementação desta spec só começa quando essa entrega existir.**
- Esta spec vive na branch `transcricao-de-audio`, criada a partir da `modulo-design`. Ao começar a
  implementação, faça merge da `quadro-de-design` nela.
- O Módulo Design é tocado em paralelo no worktree `../repo-modulo-design`. Não troque branch lá.
- Migration: esta fase usa a próxima livre depois das do Módulo Design (hoje, `007`).

## 5. Ponte (`src/whatsapp/`)

### 5.1 Transcritor: `src/whatsapp/transcricao.ts` (novo)

```ts
export interface Transcritor {
  transcrever(dados: Buffer, mime: string): Promise<string | null>;
}
export function transcritorOpenAI(cliente: OpenAI, modelo: string): Transcritor;
```

- Chamada: `cliente.audio.transcriptions.create({ file, model, language: "pt", response_format: "text", prompt })`.
  O `file` é montado do buffer com `toFile(dados, "audio.<ext>", { type: mime })` do SDK `openai`, sem arquivo
  temporário em disco.
- Modelo: `process.env.TRANSCRICAO_MODELO ?? "whisper-1"`. Chave: a `OPENAI_API_KEY` que já existe. Acrescente
  `TRANSCRICAO_MODELO=whisper-1` ao `.env.example` da raiz.
- `prompt` fixo, curto (o Whisper só considera os ~224 tokens finais):
  > Mensagem de voz em português do Brasil de um cliente da Presentes Especiais, loja de brindes
  > personalizados. Produtos comuns: camisa dry fit, caneca mágica, squeeze, garrafa térmica, ecobag, boné,
  > caneta, chaveiro, agenda. O cliente fala quantidades (cinquenta unidades), cores, prazos e a logo da empresa.
- 3 tentativas, timeout de 60 s cada (`new OpenAI({ timeout: 60_000, maxRetries: 0 })` e o laço é nosso, para
  contar as tentativas). Entre tentativas, espera 1 s e 3 s.
- Devolve `null` quando:
  - as 3 tentativas falham;
  - o texto, depois de `trim`, fica vazio ou só com pontuação;
  - o texto normalizado (minúsculas, sem acento e sem pontuação) é igual a uma alucinação conhecida do Whisper
    em áudio sem fala: `legendas pela comunidade amara.org`, `obrigado por assistir`, `obrigada por assistir`,
    `inscreva-se no canal`, `legenda adriana zanotto`. A comparação é do texto inteiro, nunca `includes`: um
    cliente pode dizer "obrigado" numa frase real.
- Cada falha vira log `audio_tentativa_falhou` com o número da tentativa e a mensagem de erro do SDK. **O log
  nunca leva o texto transcrito.**

### 5.2 Fluxo em `receberDoCliente` (`src/whatsapp/ponte.ts:242`)

Hoje `audio` cai junto com `ignorada`: com a IA, a ponte responde `MSG_AUDIO` e conclui a mensagem; com humano,
só conclui. Passa a ser assim:

1. **Todo áudio direto do cliente é baixado uma vez**, inclusive quando `iaAtende(telefone)` é falso ou a
   conversa está com humano. Por isso o tratamento do áudio fica **antes** do `if (!this.iaAtende(...)) return`.
   Download com `baixarMidia`, `PRAZO_DOWNLOAD_MS` e o teto `TAMANHO_MAXIMO_BYTES` (16 MB) que já existem.
2. **Com a IA atendendo** (`iaAtende` verdadeiro e `atendimento.modo(telefone) === "ia"`):
   - reserva o lugar na fila **antes** do download (`fila.reservar`), como a mídia faz, para o áudio não chegar
     depois do texto que veio atrás dele;
   - transcreve;
   - com texto: `fila.preencher` com `{ id, timestamp, texto: neutralizarMarcadores(texto).slice(0, LIMITE_TEXTO), ...nomeDoContato(m) }`;
   - com `null` (ou download falho): `fila.cancelar(telefone, m.id)`, manda `MSG_AUDIO_FALHOU` pelo
     `envio.paraCliente` e conclui a mensagem, como o `MSG_AUDIO` faz hoje.
3. **Sem IA** (humano, ou número fora da IA): não transcreve, não entra na fila; conclui a mensagem e marca como
   lida nas mesmas condições de hoje.
4. **Em qualquer caso, com o download bem-sucedido**, manda ao observador `observador.midia({ id, telefone, mime,
   base64, transcricao, status })`, com `status` `OK`, `FALHOU` ou `NAO_TRANSCRITO`.

Constante nova, no lugar da `MSG_AUDIO` (que sai):
```ts
export const MSG_AUDIO_FALHOU = "Não consegui ouvir seu áudio direito 🙏 Pode me mandar por escrito?";
```

O `Transcritor` entra na ponte pelas `OpcoesPonte` (campo `transcritor?`), para o teste injetar um falso. Sem
transcritor configurado, a ponte se comporta como `FALHOU`.

### 5.3 Observador (`src/whatsapp/crm.ts`)

- `ObservadorPonte` ganha `midia(m: MidiaObservada): void`.
- `ObservadorCrm.midia` enfileira `{ rota: "midias", corpo: m }` na mesma fila FIFO das mensagens. Como o item
  `mensagens` do mesmo id foi enfileirado antes (em `observar`), a linha da mensagem já existe no CRM quando o
  áudio chega.
- O comportamento de reenvio não muda: 2xx ou 4xx (fora 429) tiram o item da fila; 5xx e erro de rede repetem
  com o backoff atual.
- `shortcut: os bytes do áudio ficam na memória da fila até o CRM aceitar; se a ponte reiniciar com o CRM fora, o
  áudio se perde (a transcrição já foi para a Lia). Trocar por fila em disco quando a ponte for para a nuvem.`
  Um áudio de 1 min em Opus tem uns 100 a 200 KB; `MAX_FILA` segue valendo.

## 6. CRM (`crm/`)

### 6.1 Migration `crm/db/migrations/007_audio.sql`

```sql
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_key TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_bytes INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription_status TEXT
  CHECK (transcription_status IN ('OK', 'FALHOU', 'NAO_TRANSCRITO'));
```

O `body` da mensagem de áudio continua "🎤 Áudio" (`KIND_LABEL` em `crm/src/lib/ingest.ts:444`). A transcrição
fica na coluna própria, para não se misturar com o que o cliente digitou.

### 6.2 `detectarTipo` aceita áudio

Em `crm/src/lib/arquivos.ts`, três tipos novos, conferidos pelos primeiros bytes:
- `ogg`: começa com `OggS` (é o `ptt` do WhatsApp, Opus);
- `mp3`: começa com `ID3`, ou com `FF` seguido de um byte `E0`–`FF` (frame sync);
- `m4a`: bytes 4–7 são `ftyp`.

### 6.3 `POST /api/integracao/midias` (novo)

- Autenticação: `integrationAuthorized` (`x-crm-secret`), como as outras rotas de `/api/integracao/`.
- Corpo validado: `{ id: string, telefone: string, mime: string, base64: string, transcricao?: string | null,
  status: "OK" | "FALHOU" | "NAO_TRANSCRITO" }`. `transcricao` só é aceita com `status === "OK"`.
- Teto de 16 MB decodificados. Tipo pelo `detectarTipo`, nunca pelo `mime` declarado; fora de ogg, mp3 ou m4a,
  responde 422.
- Busca a mensagem por telefone (`digits`) + `external_id = id` + `source = 'WHATSAPP'`:
  - não existe: 404;
  - `media_key` já preenchido: 200 sem regravar (a ponte pode repetir o envio).
- Grava no `Armazem` com a chave `audios/<lead_id>/<message_id>.<ext>`, montada no servidor. Depois, um
  `UPDATE messages` com as cinco colunas. Se o `Armazem` falhar, responde 500 e a ponte tenta de novo.

### 6.4 `GET /api/leads/[id]/messages/[messageId]/audio` (novo)

- Exige sessão e passa pelo `leadScope` do lead: o vendedor só ouve áudio dos leads que vê; fora do escopo, 403.
- Mensagem sem `media_key`: 404.
- Responde 302 para `armazem().urlTemporaria(media_key)`. No R2 é a URL assinada; no disco é a rota assinada do
  Módulo Design (`/api/design/arquivo`).
- **A rota de disco do Módulo Design precisa responder `Range`** (206 com `Content-Range` e `Accept-Ranges:
  bytes`), ou o player não consegue avançar no áudio. Se ela ainda não fizer isso, a mudança entra nesta fase.

### 6.5 Painel do lead

- A query de mensagens em `crm/src/app/api/leads/[id]/route.ts:21` passa a trazer `m.transcription`,
  `m.transcription_status` e `(m.media_key IS NOT NULL) AS has_media`. A chave do `Armazem` não vai ao navegador.
- `Message` (`crm/src/lib/types.ts:85`) ganha `transcription?: string | null`, `transcription_status?: string |
  null` e `has_media?: boolean`.
- Em `Conversation` (`crm/src/components/crm/LeadPanel.tsx:296`), quando `m.kind === "audio"` e `m.has_media`:
  - `<audio controls preload="none" src={`/api/leads/${leadId}/messages/${m.id}/audio`} />` no lugar do
    `{m.body}`; o `preload="none"` evita baixar todos os áudios ao abrir o lead;
  - `OK`: a transcrição embaixo, em itálico, com o prefixo "Transcrição:";
  - `FALHOU`: o aviso "Transcrição falhou: ouça o áudio";
  - `NAO_TRANSCRITO`: só o player.
- Sem `has_media` (histórico antigo ou envio que não chegou), o balão segue com "🎤 Áudio".
- As listas e a prévia do lead não mudam.

## 7. Testes

Agente (vitest):
- `tests/transcricao.test.ts` (novo), com cliente OpenAI falso: a chamada leva `whisper-1`, `language: 'pt'` e o
  `prompt`; texto vazio vira `null`; cada alucinação da lista vira `null`; frase real com "obrigado" passa;
  3 falhas viram `null`, sem 4ª chamada; o log de falha não contém o texto.
- `tests/ponte.test.ts` e `tests/ponteRegressoes.test.ts`, trocando os testes atuais do `MSG_AUDIO`:
  - com a IA: o texto do áudio entra no lote antes do texto digitado que chegou depois;
  - com falha: sai `MSG_AUDIO_FALHOU`, a reserva é cancelada e o lote dos outros textos segue;
  - com humano e com número fora da IA: não chama o transcritor, não entra na fila e o observador recebe
    `NAO_TRANSCRITO`;
  - download falho: nenhum item `midia` vai ao observador.
- Teste do `ObservadorCrm`: o item `midias` sai depois do `mensagens` do mesmo id.

CRM (vitest com pglite, introduzido pelo Módulo Design):
- `POST /api/integracao/midias`: 401 sem segredo; 404 sem mensagem; 422 com bytes que não são áudio; 200 e
  colunas gravadas; segundo envio não regrava; `transcricao` com `status` diferente de `OK` é recusada.
- `GET .../audio`: 403 para vendedor fora do lead; 302 para quem vê o lead.
- `detectarTipo`: os três tipos de áudio e um arquivo com extensão de áudio mas bytes de PNG.

Evals: nenhum muda (a Lia recebe texto puro). Rode a suíte uma vez para confirmar que nada regrediu.

Dogfooding, com o número extra do João: 3 áudios reais (um com quantidade e nome de produto, um com barulho, um
mudo), conferindo a resposta da Lia e o player no CRM. Depois, um áudio com a conversa em modo humano.

## 8. Privacidade (o repositório é público)

- Áudio de cliente é dado de cliente: nenhum áudio real entra no repo, em fixture, em issue ou em commit.
- Fixtures usam bytes sintéticos (`OggS` seguido de zeros) e transcrições inventadas.
- O log nunca leva o texto transcrito nem os bytes.
- Banco: só o Postgres do Docker (5440). Nunca migration, seed ou sync contra o Neon.

## 9. Riscos conhecidos

- **Espera no pior caso:** 3 tentativas de 60 s seguram o lote daquela conversa por até ~3 min. O caso normal é
  de poucos segundos; se incomodar, baixe o timeout.
- **Alucinação fora da lista:** o Whisper às vezes inventa frase em áudio mudo. A lista cobre as mais comuns; uma
  nova que aparecer no dogfooding entra nela.
- **Áudio perdido no reinício** da ponte com o CRM fora (seção 5.3).
- **Dependência do Módulo Design:** sem a entrega `quadro-de-design`, não há `Armazem` nem pglite no CRM.
