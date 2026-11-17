# Módulo Design: kit de partida por IA e quadro do designer

> Spec de 15/11/2026. Base: a proposta do Luis (Dudu) na task do ClickUp "Módulo Design"
> (https://app.clickup.com/t/wdp7exb7q7, 04/11/2026). Esta spec fecha as decisões em aberto da task
> e diz arquivo por arquivo o que construir. Escrita para quem nunca mexeu neste repositório.
>
> **Quem recebe esta spec escreve o plano, implementa e valida.** O plano vai em
> `docs/superpowers/plans/`, cobrindo as 3 entregas da seção 14. Dúvida de produto ou de escopo vai ao
> João antes de desviar da spec; o que for decidido entra nesta spec num commit `docs(spec)`.

## 1. O que é, em uma história

1. O cliente manda no WhatsApp a foto de um uniforme: "quero uma camisa assim com a logo da minha escola".
2. Um **job de design** é aberto: pela Lia (o agente de IA do WhatsApp), pelo vendedor no CRM ou pela
   mudança do lead ou do pedido para a etapa `ARTE`.
3. Um **worker** (um script que roda em segundo plano, sem conversar com ninguém) manda a foto a um modelo
   de visão e monta o **kit de partida**: ficha técnica (peça, gola, manga, posição dos elementos), paleta de
   cores e um briefing da conversa.
4. O job cai no **quadro do designer** (uma pessoa), já atribuído a ele. O designer cria o mockup na
   ferramenta dele e sobe o arquivo no job. **O sistema não desenha nada.**
5. O designer envia o mockup pelo WhatsApp. Nesse momento ele assume a conversa e a Lia fica em silêncio.
6. O cliente pede ajustes ou aprova. Na aprovação, o cliente confirma respondendo **APROVO**.
7. A conversa volta para a Lia ou para o vendedor, a arte final vai para o pedido e o pedido segue para produção.

## 2. Escopo

**Dentro (entregas 1, 2 e 4 da task do Dudu):** papel `DESIGNER`, tabelas, armazém de arquivos, quadro e
detalhe do job, roteamento da conversa, botão "Enviar para design", worker com ficha, paleta e briefing,
ferramenta `encaminhar_design` da Lia, envio do mockup pelo WhatsApp e dupla confirmação do cliente.

**Fora:**
- Recorte de elementos (SAM 2), vetorização (Vectorizer.AI, `vtracer`) e o "Baixar kit .zip": viram só um
  benchmark escrito (seção 12). Entram numa spec futura, se o benchmark passar.
- Mockup gerado automaticamente por IA: não está na task do Dudu.
- Notificação por e-mail: o sino do CRM basta.

## 3. Decisões tomadas (15/11, João)

| # | Decisão | Por quê |
|---|---|---|
| D1 | A spec cobre as entregas 1, 2 e 4; a 3 vira benchmark | O próprio Dudu marca a 3 como a parte mais incerta, e o designer trabalha sem ela |
| D2 | Arquivos no Cloudflare R2 (S3 compatível), com modo disco em dev | O CRM e o agente precisam de um lugar comum; o R2 não cobra saída. A conta é pedida ao Dudu (seção 13) |
| D3 | Só abre job quando há trabalho de arte. Logo pronta para gravar segue no `registrar_arte` de hoje | Não mexe no fluxo de orçamento que funciona e não enche o quadro do designer |
| D4 | Aprovação: o designer marca "Cliente aprovou", o sistema pede "APROVO" e só essa resposta aprova, conferida por código | Prova de que o cliente aprovou; sem depender do LLM nem de enquete do WhatsApp |
| D5 | O CRM é dono de tudo do design; o agente só encaminha e envia | Segue o desenho atual (CRM dono dos dados, ponte é canal). Só o CRM guarda a credencial do R2. O worker roda mesmo com a Lia desligada |
| D6 | Atribuição automática por rodízio entre usuários `DESIGNER` ativos | Decisão 2 da task: mesmo critério da distribuição de atendimento, mesmo com um designer só |
| D7 | O `DESIGNER` vê só o quadro de design e os leads com job atribuído a ele | Decisão 1 da task |

## 4. Mapa do repositório (o que você precisa saber antes)

Repositório: `caioqueirozzz/presentes-especiais` (antigo `agente-brindeme`). **É público: nunca ponha
telefone, chave ou dado de cliente em código, issue, commit ou teste.**

São dois projetos no mesmo repositório, que conversam por HTTP com um segredo compartilhado
(`CRM_INTEGRATION_SECRET`, cabeçalho `x-crm-secret` num sentido e `x-ponte-secret` no outro):

| Projeto | Pasta | O que é | Comandos |
|---|---|---|---|
| Agente (Lia) + ponte do WhatsApp | raiz (`src/`) | TypeScript com `tsx`, OpenAI, `whatsapp-web.js`, vitest | `npm run whatsapp:ponte`, `npm test`, `npm run evals`, `npm run typecheck` |
| CRM | `crm/` | Next.js 16 + React 19, `pg` ou `pglite`, sem testes hoje | `npm run dev` (porta 3200), `npm run db:migrate`, `npm run typecheck` |

Peças existentes que este módulo usa:

| Peça | Arquivo | Como é usada aqui |
|---|---|---|
| Etapa `ARTE` de leads e pedidos | `crm/db/migrations/001_inicial.sql`, `003_pedidos.sql` | Gatilho de abertura de job |
| Notificação (sino) | `notify()` em `crm/src/lib/leads.ts` | Avisar designer e vendedor |
| Linha do tempo | `logEvent()` em `crm/src/lib/leads.ts` | Modelo para `design_events` |
| Rodízio de vendedores | `autoAssignLead()` em `crm/src/lib/leads.ts` | Modelo para o rodízio do designer |
| Escopo de acesso | `leadScope()`, `requireUser()` em `crm/src/lib/access.ts` | Restringir o `DESIGNER` |
| Mensagem ao vivo do WhatsApp | `ingestLiveMessage()` em `crm/src/lib/ingest.ts` | Conferir o "APROVO" e notificar o designer |
| Envio pelo CRM | `crm/src/app/api/leads/[id]/enviar/route.ts` → ponte `/enviar` | O designer fala com o cliente; o lead vira `agent_mode = 'humano'` e a Lia pausa |
| Devolver à IA | `crm/src/app/api/leads/[id]/devolver/route.ts` → ponte `/devolver` | Fim do job |
| Cliente da ponte | `callPonte()` em `crm/src/lib/whatsapp.ts` | Chamar `/enviar-midia` e `/encaminhar-design` |
| Servidor de controle da ponte | `src/whatsapp/controle.ts` | Ganha 2 rotas |
| Envio de imagem | `Sessao.enviarImagem()` em `src/whatsapp/sessao.ts` | Envia o mockup como foto |
| Arquivos recebidos do cliente | `state.arquivosRecebidos` (`src/agent/state.ts`), gravados por `src/whatsapp/midia.ts` | Imagens que vão para o job |
| Quadros (kanban) | `crm/src/components/boards/BoardsView.tsx`, `OrdersBoard.tsx` | Padrão visual do quadro de design |
| Tela de equipe | `crm/src/components/admin/TeamView.tsx` | Criar usuário `DESIGNER` |
| OpenAI no CRM | `crm/src/lib/ia/assistant.ts` (usa `fetch` direto) | Mesmo padrão no worker; reaproveita `OPENAI_API_KEY` do `.env` do CRM |

**Ponto importante:** hoje o CRM nunca recebe os bytes das imagens do WhatsApp. Ele só mostra
"📎 Arquivo enviado". As imagens ficam no disco da máquina da ponte. Por isso existe o armazém (seção 6)
e a rota `/encaminhar-design` na ponte (seção 9).

### Ambiente de desenvolvimento

1. Branch: esta spec está na branch `modulo-design`, criada a partir de `banco-neon` (a mais recente;
   contém a `main`). A entrega 1 parte dela (seção 14).
2. Agente: `npm ci` na raiz, `.env` copiado de `.env.example`, `npm run db:subir` (Postgres em Docker na
   porta 5440), `npm run db:migrate`.
3. CRM: o worker é um segundo processo e o `pglite` aceita um processo só. Use o Postgres do Docker:
   ```bash
   docker exec agente-banco psql -U postgres -c "CREATE DATABASE crm OWNER crm"
   ```
   e no `crm/.env`: `DATABASE_URL=postgres://crm:crm@127.0.0.1:5440/crm`. Depois `npm ci`,
   `npm run db:migrate` e `npm run admin:criar` dentro de `crm/`.
4. **Nunca** rode `db:seed`, `sync:pedidos` ou migrations contra o Neon. Só contra o Docker.
5. Arquivos em dev: sem as variáveis `R2_*`, o armazém grava em `crm/data/arquivos/` (pôr no `.gitignore`).

## 5. Modelo de dados: `crm/db/migrations/006_design.sql`

O SQL do Dudu com 4 ajustes, marcados com `-- ajuste`:

```sql
-- Papel novo
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('ADMIN', 'COLABORADOR', 'DESIGNER'));

-- ajuste 1: rodízio do designer, separado do rodízio de vendedores
ALTER TABLE crm_settings ADD COLUMN IF NOT EXISTS last_designer_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS design_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  designer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,  -- null = Lia
  origem TEXT NOT NULL CHECK (origem IN ('LIA', 'VENDEDOR', 'PEDIDO')),
  stage TEXT NOT NULL DEFAULT 'RECEBIDO' CHECK (stage IN (
    'RECEBIDO', 'PROCESSANDO_IA', 'NA_FILA', 'EM_CRIACAO',
    'AGUARDANDO_CLIENTE', 'AJUSTES', 'APROVADO', 'CANCELADO')),
  ia_status TEXT NOT NULL DEFAULT 'PENDENTE'
    CHECK (ia_status IN ('PENDENTE', 'OK', 'FALHOU', 'SEM_IMAGEM')),  -- ajuste 2: SEM_IMAGEM
  ia_tentativas INTEGER NOT NULL DEFAULT 0,                          -- ajuste 2
  ia_proxima_tentativa_em TIMESTAMPTZ,                               -- ajuste 2: espera entre tentativas
  ficha JSONB NOT NULL DEFAULT '{}'::jsonb,
  briefing TEXT,
  prioridade TEXT NOT NULL DEFAULT 'normal' CHECK (prioridade IN ('normal', 'alta')),
  prazo TIMESTAMPTZ,
  conversa_com_designer BOOLEAN NOT NULL DEFAULT false,
  confirmacao_pedida_em TIMESTAMPTZ,                                 -- ajuste 3: dupla confirmação
  confirmacao_versao INTEGER,                                        -- ajuste 3
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_design_jobs_stage ON design_jobs(stage);
CREATE INDEX IF NOT EXISTS idx_design_jobs_designer ON design_jobs(designer_id);
CREATE INDEX IF NOT EXISTS idx_design_jobs_lead ON design_jobs(lead_id);
-- ajuste 4: no máximo um job aberto por lead
CREATE UNIQUE INDEX IF NOT EXISTS uq_design_jobs_lead_aberto
  ON design_jobs(lead_id) WHERE stage NOT IN ('APROVADO', 'CANCELADO');

CREATE TABLE IF NOT EXISTS design_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES design_jobs(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN (
    'ORIGINAL', 'LOGO', 'ESTAMPA', 'TEXTO', 'PALETA',
    'SVG', 'MOCKUP', 'ARTE_FINAL')),
  arquivo TEXT,          -- CHAVE no armazém (ex.: design/<job>/original-1.jpg), nunca URL
  mime TEXT,
  bytes INTEGER,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  versao INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_design_assets_job ON design_assets(job_id, tipo);

CREATE TABLE IF NOT EXISTS design_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES design_jobs(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- null = sistema, Lia ou cliente
  tipo TEXT NOT NULL,
  dados JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_design_events_job ON design_events(job_id, created_at);
```

Os tipos `LOGO`, `ESTAMPA`, `TEXTO` e `SVG` ficam no `CHECK` para a entrega futura, mas nada desta spec
os grava. A paleta fica dentro de `ficha` (não como asset).

Tipos de `design_events` usados: `criado`, `imagem_anexada`, `ia_ok`, `ia_falhou`, `atribuido`, `etapa`,
`mockup_enviado`, `mensagem_designer`, `confirmacao_pedida`, `resposta_confirmacao`, `aprovado`,
`cancelado`, `devolvido`. O `dados` de `ia_ok`/`ia_falhou` traz `input_tokens`, `output_tokens` e `modelo`.

## 6. Armazém de arquivos: `crm/src/lib/arquivos.ts`

Interface única, duas implementações escolhidas pelo `.env`:

```ts
export interface Armazem {
  salvar(chave: string, bytes: Buffer, mime: string): Promise<void>;
  ler(chave: string): Promise<Buffer>;
  urlTemporaria(chave: string, segundos?: number): Promise<string>; // padrão 600 s
}
export function armazem(): Armazem; // R2 se R2_BUCKET estiver definido, senão disco
```

- **R2:** `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner`, endpoint
  `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, região `auto`. O bucket é privado; toda leitura pelo
  navegador passa por URL assinada de 10 min.
- **Disco:** grava em `crm/data/arquivos/<chave>`. A `urlTemporaria` devolve uma rota do próprio CRM,
  `/api/design/arquivo?chave=...&exp=...&sig=...`, assinada com HMAC do `AUTH_SECRET`. A rota confere a
  assinatura e a validade e também exige usuário logado.
- A chave nunca vem do cliente HTTP: é montada pelo servidor (`design/<job_id>/<tipo>-<uuid>.<ext>`).
  Rejeite qualquer chave com `..` ou `\`.

Variáveis novas no `crm/.env.example`:
```
# Armazém do Módulo Design (vazio = disco em crm/data/arquivos)
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
```

### Validação de upload (vale para toda entrada de arquivo)

- Tipos aceitos, **conferidos pelos primeiros bytes**, não pela extensão nem pelo `Content-Type`:
  PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), WEBP (`RIFF....WEBP`), PDF (`%PDF`), SVG (texto que, depois de
  espaços e de um `<?xml ...?>` opcional, começa com `<svg`).
- Tamanho máximo: 16 MB (o mesmo limite de `src/whatsapp/midia.ts`).
- SVG é guardado e oferecido só para **download** (`Content-Disposition: attachment`), nunca exibido em
  `<img>` nem inline: SVG pode carregar script.
- Função pura `detectarTipo(bytes): "png" | "jpeg" | "webp" | "pdf" | "svg" | null`, com teste.

## 7. Regras do job: `crm/src/lib/design.ts`

Toda escrita em `design_*` passa por este módulo. Rotas e worker não escrevem SQL de design direto.

```ts
abrirOuAnexar(p: { leadId; origem; requestedBy?; orderId?; motivo?; observacao?; prioridade?;
                   imagens: { bytes: Buffer; nome: string }[] }): Promise<{ jobId; criado: boolean }>
mudarEtapa(jobId, para: Etapa, atorId: string | null, dados?): Promise<void>   // valida a transição
atribuirDesigner(jobId): Promise<string | null>                                // rodízio
anexarMockup(jobId, arquivo, atorId): Promise<{ versao: number }>
enviarMockup(jobId, versao, legenda, atorId): Promise<void>
pedirConfirmacao(jobId, atorId): Promise<void>
receberRespostaDoCliente(leadId, texto): Promise<"aprovado" | "nao_confirmou" | "sem_confirmacao_pendente">
devolverAoAtendimento(jobId, atorId, nota?): Promise<void>
```

### Abertura (`abrirOuAnexar`)

Numa transação:
1. Procura o job aberto do lead (`stage NOT IN ('APROVADO','CANCELADO')`) com `FOR UPDATE`.
2. Se não existe, cria com `stage = 'RECEBIDO'`. Se dois gatilhos chegarem juntos, o índice único faz o
   segundo falhar: capture o erro `23505` e repita a partir do passo 1 (uma vez).
3. Valida e salva cada imagem como asset `ORIGINAL` (seção 6). Registra `imagem_anexada`.
4. Grava `motivo`/`observacao` no `briefing` provisório.
5. Decide a etapa:
   - job novo **com** imagem analisável (PNG, JPEG, WEBP) → `PROCESSANDO_IA`;
   - job novo **sem** imagem analisável → `ia_status = 'SEM_IMAGEM'` e `NA_FILA`;
   - job existente ainda não assumido (`RECEBIDO`, `PROCESSANDO_IA`, `NA_FILA`) com imagem nova → volta
     para `PROCESSANDO_IA` e zera `ia_tentativas`;
   - job existente em `EM_CRIACAO` ou depois → só anexa e notifica o designer ("cliente mandou imagem nova").

### Etapas e transições permitidas

| De | Para | Quem | Efeito colateral |
|---|---|---|---|
| `RECEBIDO` | `PROCESSANDO_IA`, `NA_FILA` | sistema | — |
| `PROCESSANDO_IA` | `NA_FILA` | worker | `atribuirDesigner` |
| `NA_FILA` | `PROCESSANDO_IA` | designer ou admin ("Reprocessar IA") | zera `ia_tentativas` |
| `NA_FILA` | `EM_CRIACAO` | designer atribuído ou admin ("Começar") | — |
| `EM_CRIACAO`, `AJUSTES` | `AGUARDANDO_CLIENTE` | designer ("Enviar mockup") | envia a imagem; `conversa_com_designer = true` |
| `AGUARDANDO_CLIENTE` | `AJUSTES` | designer ("Marcar ajustes") | apaga `confirmacao_*` |
| `AGUARDANDO_CLIENTE` | `APROVADO` | **só** `receberRespostaDoCliente` | seção 7.2 |
| qualquer aberta | `CANCELADO` | designer atribuído ou admin | devolve a conversa se `conversa_com_designer` |

Qualquer outra transição lança `DesignError` (a rota responde 409). Toda mudança grava `etapa` em
`design_events` e atualiza `updated_at`.

### 7.1 Rodízio do designer (`atribuirDesigner`)

Cópia da lógica de `autoAssignLead`: trava `crm_settings` com `FOR UPDATE`, lista
`users WHERE role = 'DESIGNER' AND is_active ORDER BY created_at, id`, pega o próximo depois de
`last_designer_id`, grava e notifica o escolhido ("Novo job de design: <cliente>", link para o job).
Sem designer ativo: o job fica sem `designer_id` e todos os `ADMIN` são notificados. O botão "Assumir"
só aparece nesse caso.

### 7.2 Dupla confirmação (D4)

1. O designer clica "Cliente aprovou" (só em `AGUARDANDO_CLIENTE`). `pedirConfirmacao`:
   - grava `confirmacao_pedida_em = NOW()` e `confirmacao_versao` = última versão de `MOCKUP` enviada;
   - reenvia esse mockup pela ponte `/enviar-midia` com a legenda fixa:
     > Para confirmar: esta é a arte final (versão N) que vai para produção. Depois de confirmada, ela não
     > muda mais. Se estiver tudo certo, responda **APROVO**.
   - registra `confirmacao_pedida` com o texto enviado.
2. Toda mensagem do cliente chega ao CRM por `ingestLiveMessage`. Depois de gravar a mensagem, se
   `autor === 'CLIENTE'`, chame `receberRespostaDoCliente(leadId, texto)`:
   - sem job com `confirmacao_pedida_em` preenchido → `sem_confirmacao_pendente`, nada acontece;
   - normalize o texto (minúsculas, sem acento, sem pontuação, espaços colapsados). **Só** o texto
     normalizado igual a `aprovo` aprova. "aprovo sim", "ok", "pode ser", "👍" **não** aprovam;
   - registra `resposta_confirmacao` com o texto original, aprovando ou não (é a prova);
   - não aprovou → mantém `AGUARDANDO_CLIENTE` e notifica o designer ("cliente respondeu, mas não
     confirmou com APROVO");
   - aprovou → `APROVADO`: copia o mockup confirmado como asset `ARTE_FINAL`; se houver `order_id`, move o
     pedido para `PRODUCAO` registrando em `order_events` como o resto do CRM faz; senão notifica o vendedor
     do lead ("arte aprovada, falta o pedido"); chama `devolverAoAtendimento`.
3. A conferência é código puro (função `ehAprovacao(texto): boolean`, com teste). Nenhum LLM decide isso.

### 7.3 Quem fala com o cliente

- O designer fala pelo **mesmo** `POST /api/leads/[id]/enviar` que o vendedor usa. Isso já põe o lead em
  `agent_mode = 'humano'`, e a ponte já pausa a Lia quando um humano manda mensagem pelo chip.
- "Falar com o cliente" e "Enviar mockup" ligam `conversa_com_designer`.
- Com `conversa_com_designer = true`, o `ingestLiveMessage` manda a notificação de mensagem nova do
  cliente ao `designer_id` em vez de ao vendedor (`assigned_to`). O lead continua do vendedor.
- `devolverAoAtendimento`: `conversa_com_designer = false`, chama `callPonte('/devolver', { telefone, nota })`
  (a Lia volta) e registra `devolvido`. Se o vendedor estava atendendo antes do job (o lead já era
  `humano` quando o job abriu, guardado em `design_events.criado.dados.modo_anterior`), **não** chame
  `/devolver`: só notifique o vendedor de que a conversa voltou para ele.

## 8. Worker: `crm/scripts/designWorker.ts`

Comando novo no `crm/package.json`: `"design:worker": "tsx --env-file-if-exists=.env scripts/designWorker.ts"`.

Laço:
```
enquanto não receber SIGINT/SIGTERM:
  numa transação: SELECT ... FROM design_jobs WHERE stage = 'PROCESSANDO_IA'
                  AND (ia_proxima_tentativa_em IS NULL OR ia_proxima_tentativa_em <= NOW())
                  ORDER BY prioridade = 'alta' DESC, created_at LIMIT 1 FOR UPDATE SKIP LOCKED
  nenhum → espera 5 s
  um → processa (fora da transação de busca, marcando ia_tentativas + 1 antes de chamar a OpenAI)
```
Concorrência 1. Loga uma linha por job (`job`, `etapa`, `ms`, `tokens`, `erro`), sem conteúdo da conversa.

### Processamento de um job

1. Lê até 4 assets `ORIGINAL` analisáveis (PNG, JPEG, WEBP), os mais recentes. SVG e PDF não vão ao
   modelo.
2. Com `sharp`: reduz cada imagem para no máximo 1024 px no maior lado, em JPEG qualidade 85. Guarda a
   largura e a altura usadas.
3. **Ficha e briefing:** uma chamada `POST https://api.openai.com/v1/chat/completions` (mesmo padrão de
   `crm/src/lib/ia/assistant.ts`), modelo `IA_MODEL` ou `LLM_MODEL` (hoje `gpt-4o-mini`), com as imagens
   em `image_url` base64, as últimas 20 mensagens do lead (só texto) e
   `response_format: { type: "json_schema", ... }`. Timeout 60 s. Prompt de sistema:
   > Você descreve imagens de referência de uniformes e brindes para um designer. Descreva só o que se vê.
   > Não invente texto, marca ou cor que não esteja na imagem. Se não tiver certeza, deixe o campo nulo e
   > explique em "observacoes". Resuma o pedido do cliente em "briefing", em 3 a 5 linhas, sem telefone,
   > e-mail ou dado de pagamento.
4. Valide a resposta com `zod` (esquema abaixo). Inválida conta como falha.
5. **Paleta**, em código, sem LLM: com `sharp`, reduza a primeira imagem para 64×64 e leia os pixels
   (`raw()`); rode k-means em RGB com k = 6, 10 iterações e sementes fixas (resultado determinístico);
   descarte grupos com menos de 3% dos pixels; ordene por participação. Para cada cor, ache o Pantone mais
   próximo por ΔE (CIE76, em Lab) na tabela local `crm/src/lib/design/pantone.json`
   (`[{ "codigo": "281 C", "hex": "#00205B" }, ...]`, fonte a confirmar com o Dudu, seção 13).
6. Grava `ficha = { ...respostaDoModelo, paleta, imagem_analisada: { largura, altura } }`, `briefing`,
   `ia_status = 'OK'`, evento `ia_ok` com tokens, e chama `mudarEtapa(..., 'NA_FILA')`.

Esquema da ficha (o mesmo formato do exemplo do Dudu):
```ts
const Ficha = z.object({
  peca: z.string().nullable(),
  gola: z.string().nullable(),
  manga: z.string().nullable(),
  tecido_provavel: z.string().nullable(),
  elementos: z.array(z.object({
    tipo: z.enum(["logo", "estampa", "texto", "numero", "outro"]),
    conteudo: z.string().nullable(),          // só para texto e número
    posicao: z.string(),                      // "peito esquerdo", "costas"...
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(), // px da imagem analisada
  })).max(20),
  observacoes: z.string().nullable(),
  briefing: z.string(),
});
// paleta (calculada em código): [{ hex: "#0A2A66", pantone_aprox: "281 C", participacao: 0.42 }]
```

### Falhas

- Timeout, 429, 5xx, JSON inválido, imagem corrompida: se `ia_tentativas < 3`, devolve o job para a fila
  com espera: `ia_proxima_tentativa_em = NOW() + 30 s` depois da 1ª falha e `+ 120 s` depois da 2ª.
- Na 3ª falha: `ia_status = 'FALHOU'`, evento `ia_falhou` com o motivo curto (sem conteúdo da conversa) e
  `mudarEtapa(..., 'NA_FILA')`. O designer trabalha sem a IA.
- 401 da OpenAI ou `OPENAI_API_KEY` vazia: falha na hora, sem novas tentativas, e loga em destaque.
- O worker nunca derruba o processo por erro de um job: captura, registra e segue para o próximo.

## 9. Mudanças no agente (raiz do repositório)

### 9.1 Ponte: `src/whatsapp/controle.ts`

Duas rotas novas, com o mesmo `x-ponte-secret` das existentes:

**`POST /enviar-midia`** `{ telefone, url, legenda }`
- Mesmas validações de `/enviar` (telefone com 10+ dígitos, WhatsApp `CONECTADO`).
- `url` precisa ser `https://` ou `http://127.0.0.1`/`localhost` (modo disco). Legenda até 1.000 caracteres.
- Envia com `Sessao.enviarImagem` (que usa `MessageMedia.fromUrl` com `unsafeMime: true` e
  `sendSeen: false`; não troque, isso foi testado em 05/11).
- **Não** registre esse envio como mensagem da Lia no registro de saída (`src/whatsapp/envio.ts`): ele tem
  de aparecer como mensagem de atendente, para a Lia pausar como pausa quando um humano escreve.
- Responde `{ id }`.

**`POST /encaminhar-design`** `{ telefone, origem: "VENDEDOR", requested_by }`
- Usada pelo botão "Enviar para design" do CRM. Lê os `arquivosRecebidos` da conversa desse telefone e
  chama a mesma função da ferramenta da Lia (9.2). Responde `{ jobId, imagens }`.
- Conversa sem arquivos recebidos: chama o CRM sem imagens (o job abre em `NA_FILA`, `SEM_IMAGEM`).

### 9.2 Envio ao CRM: `src/whatsapp/crm.ts` (onde já ficam as chamadas da ponte ao CRM)

`encaminharParaDesign({ telefone, origem, motivo?, observacao?, prioridade?, requestedBy?, arquivos })`
lê os arquivos do disco e faz `POST {CRM_URL}/api/integracao/design` como `multipart/form-data`
(campos de texto + um campo `imagem` por arquivo), com `x-crm-secret`. Timeout 30 s.

### 9.3 Ferramenta da Lia: `src/tools/encaminharDesign.ts`

Ao lado de `registrarArte.ts`, com o mesmo formato (schema `zod` + handler), registrada onde as outras
ferramentas são registradas.

```ts
export const encaminharDesignSchema = z.object({
  motivo: z.enum(["referencia_uniforme", "criacao_de_arte", "ajuste_de_arte"])
    .describe("Por que a arte vai para o designer"),
  observacao: z.string().max(500).optional()
    .describe("O que o cliente pediu, em uma frase"),
});
```
- Usa todos os `state.arquivosRecebidos` da conversa.
- Sucesso → `{ status: "encaminhado", mensagem: "Recebi! Vou passar para nossa equipe de design, que vai te chamar por aqui." }`.
- CRM fora ou erro → `{ status: "erro", mensagem: "..." }` e a instrução de transferir para humano. Nada
  se perde: os arquivos continuam na conversa.
- Idempotente: chamar duas vezes no mesmo turno não abre dois jobs (o CRM anexa ao job aberto).

### 9.4 `src/tools/transferirHumano.ts`

Nos motivos `ajuste_mockup` e `arte_problematica`, depois da transferência normal, chame
`encaminharParaDesign` com `origem: "LIA"` e o motivo na observação. Falha no CRM não pode quebrar a
transferência: registre no log e siga.

### 9.5 Prompt da Lia (precisa do OK do João antes de entrar)

Texto proposto, a acrescentar na seção de arte do prompt:
> Use `encaminhar_design` quando o cliente mandar uma referência de uniforme ou peça para reproduzir,
> pedir que a equipe crie uma arte, ou pedir ajuste numa arte já enviada. Se o cliente mandar uma logo
> pronta só para gravar num produto, use `registrar_arte` e siga com o orçamento: isso não vai para o
> designer. Depois de encaminhar, responda só a mensagem que a ferramenta devolver.

Mudança de prompt exige A/B: rode `npm run evals` antes e depois, com 3 rodadas, nos cenários afetados:
`10_pede_atendente`, `11_api_500`, `15_arte_exe`, `22_reclamacao`, `25_insiste_humano`, `32_pix_nunca_sai`,
mais os 3 novos (seção 11). Nenhum cenário existente pode cair.

## 10. CRM: rotas e telas

### 10.1 Rotas

| Método e caminho | Quem | Faz |
|---|---|---|
| `POST /api/integracao/design` | ponte (`x-crm-secret`) | Acha o lead pelo telefone (como `ingestLiveMessage`), valida os arquivos, chama `abrirOuAnexar` |
| `GET /api/design` | `ADMIN`, `DESIGNER` | Jobs do quadro (designer: só os dele; abertos + aprovados dos últimos 14 dias) |
| `GET /api/design/[id]` | `ADMIN`, `DESIGNER` atribuído | Job, assets com URL temporária, eventos e as últimas 50 mensagens |
| `POST /api/design/[id]/etapa` | idem | `{ para }` → `mudarEtapa` |
| `POST /api/design/[id]/mockup` | idem | Upload (multipart) → `anexarMockup` |
| `POST /api/design/[id]/enviar-mockup` | idem | `{ versao, legenda }` → `enviarMockup` |
| `POST /api/design/[id]/confirmar` | idem | `pedirConfirmacao` |
| `POST /api/design/[id]/devolver` | idem | `devolverAoAtendimento` |
| `POST /api/design/[id]/assumir` | `DESIGNER` | Só se `designer_id` for nulo |
| `GET /api/design/arquivo` | logado | Serve arquivo do modo disco com assinatura válida |
| `POST /api/leads/[id]/design` | `ADMIN`, `COLABORADOR` com acesso ao lead | Botão "Enviar para design": chama a ponte `/encaminhar-design`; aceita também upload manual |

Todas usam `requireUser()`, `jsonError()` e `serverError()` de `access.ts`, como as rotas existentes.
"Designer atribuído" é conferido no servidor em toda rota, não só escondido na tela.

**Gatilho por etapa `ARTE`:** nos pontos onde o CRM muda a etapa de um lead ou de um pedido, quando a
nova etapa for `ARTE`, chame `abrirOuAnexar({ origem: "PEDIDO", imagens: [] })`. Se já houver job aberto,
nada muda.

### 10.2 Acesso do `DESIGNER` (`crm/src/lib/access.ts`)

- `leadScope`: para `DESIGNER`, o filtro passa a ser
  `EXISTS (SELECT 1 FROM design_jobs j WHERE j.lead_id = l.id AND j.designer_id = $n)`.
- O menu do `DESIGNER` mostra só "Design" e "Conta". As rotas de funil, pedidos, relatórios, PresentesIA e
  equipe respondem 403 para `DESIGNER` (confira cada `route.ts` em `crm/src/app/api/`).
- `TeamView.tsx` e a rota de equipe aceitam criar e editar usuário com papel `DESIGNER`. O `DESIGNER` não
  entra no rodízio de vendedores (`autoAssignLead` já filtra `role = 'COLABORADOR'`; mantenha).

### 10.3 Telas

Rotas `crm/src/app/app/design/page.tsx` e `crm/src/app/admin/design/page.tsx`, componentes em
`crm/src/components/design/`, no estilo de `components/boards/`.

**Quadro:** colunas Recebido (inclui Processando IA), Na fila, Em criação, Aguardando cliente, Ajustes e
Aprovado (últimos 14 dias). Card: miniatura do original, nome do cliente, `ficha.peca`, prazo, prioridade
e selo "IA ok", "IA falhou", "Sem imagem" ou "Analisando...". Sem arrastar e soltar: as etapas mudam pelos
botões do detalhe, porque cada transição tem efeito colateral.

**Detalhe do job (3 colunas, como o desenho do Dudu):**
- Esquerda: original(is) com os bboxes desenhados por cima (proporção pela largura e altura analisadas),
  ficha técnica e briefing.
- Centro: lista de elementos da ficha, paleta (amostra, HEX, "~Pantone"), versões do mockup (v1, v2...)
  com upload de nova versão.
- Direita: as últimas mensagens da conversa e os botões: Falar com o cliente, Pedir arquivo em alta
  (texto fixo: "Para a arte ficar perfeita, você consegue me mandar a logo no arquivo original, em boa
  resolução? Pode ser PNG, PDF ou SVG."), Enviar mockup, Marcar ajustes, Cliente aprovou, Devolver ao
  atendimento, Reprocessar IA, Cancelar.
- Cada botão só aparece nas etapas em que a transição é permitida (seção 7).

**`LeadPanel.tsx`:** botão "Enviar para design" (para `ADMIN` e `COLABORADOR`) e, com job aberto, um selo
com a etapa e o link para o job.

## 11. Testes

**CRM** (hoje sem testes): adicione `vitest` em `crm/` com `npm test`, banco `pglite` em memória por teste,
rodando as migrations. Testes mínimos:
- `detectarTipo`: cada tipo aceito, extensão mentirosa, arquivo vazio, SVG com `<?xml`.
- `ehAprovacao`: "APROVO", " aprovo! ", "Aprovó" aprovam; "aprovo sim", "ok", "pode ser", "👍" não.
- Transições: todas as permitidas passam; uma inválida de cada etapa lança `DesignError`.
- Um job aberto por lead: dois `abrirOuAnexar` concorrentes geram um job.
- Rodízio: 2 designers alternam; nenhum designer notifica os admins.
- `leadScope` do `DESIGNER`: vê o lead do job dele, não vê outro lead.
- Paleta: imagem sintética com 2 cores conhecidas (via `sharp`) devolve essas 2 cores.
- Worker com `fetch` falso: sucesso grava ficha e vai para `NA_FILA`; 3 falhas dão `FALHOU` e `NA_FILA`;
  JSON inválido conta como falha.
- Armazém em modo disco: salvar, ler e recusar chave com `..`.

**Agente** (`npm test` na raiz):
- `encaminharDesign`: sucesso, CRM fora e chamada repetida.
- `/enviar-midia` e `/encaminhar-design`: validação de entrada e WhatsApp desconectado (409).
- `transferirHumano` com `ajuste_mockup`: encaminha e não quebra se o CRM falhar.

**Evals novos** em `evals/scenarios/`:
- `42_referencia_uniforme_vai_ao_design.json`: cliente manda foto de uniforme e pede igual → chama
  `encaminhar_design`.
- `43_logo_pronta_nao_vai_ao_design.json`: cliente manda logo para gravar numa caneca → chama
  `registrar_arte`, não `encaminhar_design`.
- `44_ajuste_de_mockup_vai_ao_design.json`: cliente pede para mudar a cor da arte enviada → encaminha.

**Validação manual (dogfooding)**, com o número de teste e `ORCAMENTO_ESCRITA=simulada`: 5 fotos reais
de uniforme passando pela história da seção 1 de ponta a ponta, incluindo uma resposta "ok" (não aprova)
e depois "APROVO" (aprova). Registre o resultado em `docs/dogfooding-modulo-design.md`.

## 12. Benchmark da entrega 3 (documento, sem código no produto)

Entregue `docs/benchmark-vetorizacao.md`:
- 10 imagens reais (5 logos chapadas, 3 fotos de uniforme, 2 estampas complexas), sem dados de cliente.
- Para cada uma: recorte pelo SAM 2 (Replicate ou fal.ai) guiado pelos bboxes da ficha; vetorização pela
  Vectorizer.AI e pelo `vtracer`.
- Medir custo por imagem, tempo e uma nota de 1 a 5 dada pelo designer.
- Critério para virar entrega: nota média ≥ 3 nas logos chapadas. Se passar, abre uma spec própria.

## 13. Pedidos ao Dudu (antes da entrega 1 ir para produção)

1. **Conta Cloudflare para o R2.** Pode ser a conta dele ou uma conta nova da Presentes Especiais.
   **Não** usar conta pessoal de dev. Ativar o R2 (pede cartão cadastrado; a cota grátis é de 10 GB
   guardados por mês, 1 milhão de escritas e 10 milhões de leituras por mês), criar o bucket privado e
   gerar uma chave de API com acesso só a esse bucket. A chave fica só no `.env` do CRM. Até ela chegar,
   tudo funciona em modo disco.
2. **Quem é o designer**, para criar o usuário com o papel `DESIGNER`.
3. **Tabela Pantone:** confirmar se uma tabela pública de equivalência aproximada (HEX ↔ Pantone) basta.
   A paleta sempre aparece como "aproximada".

## 14. Ordem de entrega

Cada entrega em branch própria, com o nome do que faz (sem "fase X"), a partir da anterior. Antes de
pushar, junte os commits (docs + feat + fix). Push e PR só com o OK do João.

| # | Branch | Entrega | Pronta quando |
|---|---|---|---|
| 1 | `quadro-de-design` | Migration 006, papel `DESIGNER`, `arquivos.ts`, `design.ts`, quadro, detalhe, upload de mockup, `/enviar-midia`, `/encaminhar-design`, botão no `LeadPanel`, gatilho `ARTE`, acesso | Um job aberto pelo vendedor percorre todas as etapas até `APROVADO` com o "APROVO" |
| 2 | `kit-de-partida-por-ia` | Worker, ficha, paleta, briefing, `pantone.json` | 5 fotos reais geram ficha e paleta; uma falha forçada vai para `NA_FILA` com "IA falhou" |
| 3 | `lia-encaminha-ao-design` | `encaminhar_design`, mudança em `transferirHumano`, prompt (com OK do João), evals 42 a 44 | A/B sem queda nos evals afetados; dogfooding da seção 11 aprovado |

## 15. Riscos conhecidos

- **`whatsapp-web.js` fixado no commit `064a3d5`**: não atualize a biblioteca neste trabalho. Se o envio
  de imagem falhar em silêncio, confirmação de envio não é entrega: confira no celular.
- **Lia pausada:** se `/enviar-midia` for registrado como mensagem da Lia, ela não pausa e responde por
  cima do designer. Há teste para isso (seção 11).
- **Cliente que responde "aprovo" fora de hora** (sem confirmação pendente): não aprova nada, por desenho.
- **Custo:** cada job faz uma chamada de visão com até 4 imagens de 1024 px. Estime pelos tokens gravados
  em `design_events`, não no chute.

## 16. Decisões de 16/11 (João, no plano)

| # | Decisão | Por quê |
|---|---|---|
| D8 | As branches das entregas são encadeadas: `kit-de-partida-por-ia` parte de `quadro-de-design`, e `lia-encaminha-ao-design` parte de `kit-de-partida-por-ia` | A entrega 2 precisa da migration 006 e do `design.ts` da entrega 1 |
| D9 | No modo disco, a rota `/api/design/arquivo` vale só pela assinatura HMAC com validade de 10 min, sem login (substitui "também exige usuário logado" da seção 6) | Quem baixa o mockup para enviar é a ponte (`MessageMedia.fromUrl`), sem sessão; é o mesmo modelo da URL assinada do R2 |
| D10 | `pantone.json` começa com uma tabela curta provisória (~40 cores Pantone C comuns, HEX aproximado de referência pública), trocada quando o Dudu responder (seção 13.3) | A paleta funciona desde a entrega 2 e já aparece como "aproximada" |
| D11 | `encaminharParaDesign` fica em `src/integrations/crm/design.ts`, no padrão de `historicoCliente.ts`, e não em `src/whatsapp/crm.ts` (seção 9.2) | A ferramenta da Lia não importa da pasta da ponte, e testes e evals trocam a função por um falso |
| D12 | A tela do job não desenha as marcações (`bbox`) sobre a foto; a ficha continua gravando o campo | No dogfooding da entrega 2 o `gpt-4o-mini` errou a posição nas 5 fotos; a posição em texto ("peito esquerdo") veio certa. As caixas voltam se um modelo acertar |
| D13 | A paleta descarta o fundo: se uma cor ocupa ao menos 80% da borda da miniatura, ela e as cores parecidas saem da conta (seção 8, passo 5) | Nas fotos de catálogo o fundo branco ficava com 38% a 71% da paleta. Cores pequenas do logo ainda podem ficar abaixo dos 3% |
| D14 | A conversa do briefing usa só as mensagens depois do último job aprovado ou cancelado do lead, até 20 (seção 8, passo 3) | Com as últimas 20 sem corte, o briefing de um cliente recorrente herdava o pedido anterior |
| D15 | O DESIGNER vê no quadro, além dos jobs dele, os jobs sem designer, para poder assumir (seções 7.1 e 10.1) | Job aberto antes de existir designer ativo ficava invisível para todos; achado I2 da revisão final |
| D16 | Arquivo inválido (vazio, grande ou de tipo não aceito) é pulado e registrado em vez de recusar o lote; vão no máximo os 10 arquivos mais recentes da conversa; o mesmo arquivo (sha256) não entra de novo no job (seções 6 e 9.2) | Um SVG exportado do Illustrator ou a 11ª foto derrubavam o encaminhamento inteiro, e cada reenvio regravava as fotos e gastava outra análise; achados I3 e I4 |
