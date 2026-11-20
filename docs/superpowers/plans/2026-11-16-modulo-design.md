# Módulo Design — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o Módulo Design (quadro do designer, kit de partida por IA e encaminhamento pela Lia) nas 3 entregas da seção 14 da spec.

**Architecture:** O CRM (`crm/`) é dono de tudo do design: tabelas `design_*`, armazém de arquivos, regras do job (`crm/src/lib/design.ts`), rotas, telas e o worker. O agente (raiz) só encaminha (ferramenta da Lia, rota `/encaminhar-design` da ponte) e envia (rota `/enviar-midia`). A conferência do "APROVO" é código puro no CRM.

**Tech Stack:** CRM: Next.js 16, React 19, `pg`/`pglite`, vitest (novo), `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (novo), `sharp` e `zod` (novos, entrega 2). Agente: TypeScript + `tsx`, vitest, `zod`, `whatsapp-web.js` fixado em `064a3d5`.

**Spec:** `docs/superpowers/specs/2026-11-15-modulo-design-design.md` (commit `4419058`). O plano argumenta a partir dela; leia as duas.

## Global Constraints

- Repo público: nunca telefone, chave ou dado de cliente em código, commit, teste, fixture ou issue. Telefones de teste são fictícios (`5511900000001`...).
- Banco: só o Postgres do Docker (porta 5440, `npm run db:subir` na raiz). Nunca migration, seed ou sync contra o Neon. Nunca `db:seed`, `sync:pedidos`.
- R2 sem credenciais: `R2_*` vazias, armazém em modo disco (`crm/data/arquivos/`, já coberto pelo `data/` do `.gitignore` da raiz).
- O texto do prompt da Lia (spec 9.5) só entra com o OK do João e A/B nos evals 10, 11, 15, 22, 25 e 32 (3 rodadas antes e depois), mais 42–44.
- Commit sim; push e PR só com ordem do João. Antes de pushar, juntar commits por branch (docs + feat + fix).
- PC com 7,8 GB: suba só o necessário; Docker limitado a 2 GB; vitest com 1 worker.
- `whatsapp-web.js` não muda. `sendSeen: false` sempre. Envio de imagem só por `MessageMedia.fromUrl(url, { unsafeMime: true })`.
- Dentro de `transaction(async (tx) => ...)` use só `tx.query`: no `pglite` uma chamada a `query()` de fora dentro da transação trava (um processo, uma conexão).
- Upload: tipo pelos primeiros bytes; até 16 MB; SVG só para download (`Content-Disposition: attachment`), nunca em `<img>`.
- Chave do armazém montada só pelo servidor: `design/<job_id>/<tipo>-<uuid>.<ext>`; recusar `..` e `\`.
- Toda escrita em `design_*` passa por `crm/src/lib/design.ts`.
- Comentários enxutos no código: só o porquê que o código não mostra, numa linha.
- Desvio da spec vira pergunta ao João, com opções e recomendação; o decidido entra na spec num commit `docs(spec)`.

## Decisões de 16/11 (João, todas pela recomendação)

| # | Pergunta | Decidido |
|---|---|---|
| P1 | A spec (14) encadeia as branches; o pedido de 16/11 diz "cada uma a partir de `modulo-design`". A entrega 2 precisa da migration 006 e do `design.ts` da 1. | Encadear: `quadro-de-design` ← `modulo-design`; `kit-de-partida-por-ia` ← `quadro-de-design`; `lia-encaminha-ao-design` ← `kit-de-partida-por-ia` |
| P2 | Spec 6: a rota do modo disco "exige usuário logado", mas quem baixa o mockup para enviar é a ponte (`MessageMedia.fromUrl`), sem sessão. | A assinatura HMAC com validade de 10 min basta, igual à URL assinada do R2. Sem login na rota |
| P3 | Spec 8.5: `pantone.json` com "fonte a confirmar com o Dudu". Não há tabela no repo. | Tabela curta (~40 cores Pantone C comuns, HEX aproximado de referência pública), marcada "aproximada" na tela, trocada quando o Dudu responder |
| P4 | Spec 9.2 põe `encaminharParaDesign` em `src/whatsapp/crm.ts`, mas a ferramenta da Lia (`src/tools/`) importaria da ponte. O repo já tem o padrão `src/integrations/crm/historicoCliente.ts` (com `set...` para teste). | `src/integrations/crm/design.ts`, no padrão do `historicoCliente.ts`; a ponte e a ferramenta importam de lá |

Leituras da spec que o plano assume (não são desvios, mas ficam registradas):
- Entrar em `NA_FILA` sem `designer_id` chama `atribuirDesigner` (vale para o job `SEM_IMAGEM`, que pula o worker, e para o reprocessamento).
- O mockup aceita só PNG, JPEG e WEBP: ele vai ao cliente como foto (spec 9.1), e PDF por `fromUrl` cai como documento, que já falhou em silêncio (memória de 05/11).
- Pedido sem `lead_id` que entra em `ARTE` não abre job (`design_jobs.lead_id` é `NOT NULL`).
- Na entrega 1 não há worker: um job com imagem fica em `PROCESSANDO_IA`. A validação da entrega 1 usa job sem imagem; o caminho com imagem valida na entrega 2.

## Review Focus

1. **Lia por cima do designer:** `/enviar-midia` não pode passar pelo registro de saída (`src/whatsapp/envio.ts`); o eco tem de chegar como `ATENDENTE` e pausar a Lia. Teste na Task 8 (o tratador chama `canal.enviarImagemParaTelefone`, nunca o `Envio`).
2. **Imagem nova durante o processamento da IA:** o cliente manda outra foto enquanto o worker analisa a primeira. O resultado velho não pode empurrar o job para `NA_FILA` e enterrar a foto nova. O worker só grava `WHERE ia_tentativas = <a sua>`; `abrirOuAnexar` zera as tentativas. Teste na Task 14.
3. **Job cancelado durante o processamento:** o resultado do worker não pode ressuscitar o job. Mesmo `WHERE stage = 'PROCESSANDO_IA'`. Teste na Task 14.
4. **"aprovo" sem confirmação pendente / "ok" com confirmação pendente:** nada aprova; o segundo registra `resposta_confirmacao` e avisa o designer. Teste na Task 5.
5. **Ponte fora na aprovação:** a aprovação já gravada não pode ser desfeita porque o `/devolver` falhou; o designer é avisado para devolver à mão. Teste na Task 5.

---

# Entrega 1 — branch `quadro-de-design`

Pronta quando: um job aberto pelo vendedor percorre todas as etapas até `APROVADO` com o "APROVO".

### Task 1: vitest no CRM e banco de teste

**Files:**
- Modify: `crm/package.json` (script `test`, devDependency `vitest`)
- Create: `crm/vitest.config.ts`
- Create: `crm/tests/banco.ts`
- Test: `crm/tests/banco.test.ts`

**Interfaces:**
- Produces: `limparBanco(): Promise<void>`, `criarUsuario(p: { role: "ADMIN" | "COLABORADOR" | "DESIGNER"; nome?: string }): Promise<string>`, `criarLead(p?: { phone?: string; assignedTo?: string | null; agentMode?: "ia" | "humano" }): Promise<string>` em `crm/tests/banco.ts`.

- [ ] **Step 1: instalar o vitest no CRM**

```bash
cd crm && npm i -D vitest@3
```

- [ ] **Step 2: config com o alias `@/` e 1 worker**

`crm/vitest.config.ts`:
```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    fileParallelism: false,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "pglite:memory://", AUTH_SECRET: "segredo-de-teste-com-32-caracteres!!" },
  },
});
```
Em `crm/package.json`, `"test": "vitest run"`. Com `TEST_DATABASE_URL=postgres://crm:crm@127.0.0.1:5440/crm_teste` os mesmos testes rodam no Docker (usado na Task 11 para a concorrência).

- [ ] **Step 3: teste que falha**

`crm/tests/banco.test.ts`:
```ts
import { describe, expect, it, beforeEach } from "vitest";
import { query } from "@/lib/db";
import { criarLead, criarUsuario, limparBanco } from "./banco";

describe("banco de teste", () => {
  beforeEach(limparBanco);
  it("cria usuário e lead", async () => {
    const u = await criarUsuario({ role: "COLABORADOR" });
    const l = await criarLead({ assignedTo: u });
    const [row] = await query<{ assigned_to: string }>("SELECT assigned_to FROM leads WHERE id = $1", [l]);
    expect(row.assigned_to).toBe(u);
  });
});
```

- [ ] **Step 4: rodar e ver falhar**

Run: `cd crm && npx vitest run tests/banco.test.ts`
Expected: FAIL (`./banco` não existe).

- [ ] **Step 5: helper**

`crm/tests/banco.ts`:
```ts
import { randomUUID } from "node:crypto";
import { one, query } from "@/lib/db";

export async function limparBanco(): Promise<void> {
  await query("TRUNCATE notifications, messages, lead_events, orders, leads RESTART IDENTITY CASCADE");
  await query("UPDATE crm_settings SET last_assigned_user_id = NULL WHERE id");
  await query("DELETE FROM users");
}

let seq = 0;
export async function criarUsuario(p: { role: "ADMIN" | "COLABORADOR" | "DESIGNER"; nome?: string }): Promise<string> {
  seq++;
  const row = await one<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role, receives_leads) VALUES ($1, $2, 'x', $3, $4) RETURNING id`,
    [p.nome ?? `Pessoa ${seq}`, `p${seq}-${randomUUID().slice(0, 6)}@teste.local`, p.role, p.role === "COLABORADOR"]
  );
  return row!.id;
}

export async function criarLead(p: { phone?: string; assignedTo?: string | null; agentMode?: "ia" | "humano" } = {}): Promise<string> {
  seq++;
  const row = await one<{ id: string }>(
    "INSERT INTO leads (phone, source, assigned_to, agent_mode, name) VALUES ($1, 'AGENTE', $2, $3, $4) RETURNING id",
    [p.phone ?? `55119000${String(seq).padStart(5, "0")}`, p.assignedTo ?? null, p.agentMode ?? "ia", `Cliente ${seq}`]
  );
  return row!.id;
}
```
Confira as colunas obrigatórias de `users` e `leads` em `crm/db/migrations/001_inicial.sql` antes; acrescente o que faltar. Depois da Task 2, `limparBanco` também trunca `design_jobs` (CASCADE leva assets e events) e zera `last_designer_id`.

- [ ] **Step 6: rodar e ver passar**

Run: `cd crm && npx vitest run tests/banco.test.ts` → PASS.

- [ ] **Step 7: commit**

```bash
git add crm/package.json crm/package-lock.json crm/vitest.config.ts crm/tests
git commit -m "test(crm): vitest com banco pglite em memória"
```

### Task 2: migration 006 e papel `DESIGNER`

**Files:**
- Create: `crm/db/migrations/006_design.sql` (o SQL da spec seção 5, literal)
- Modify: `crm/src/lib/types.ts:5` (`Role`), `crm/src/lib/auth/token.ts:9,51,59` (`Role`, `verifySession`, `homeFor`), `crm/src/proxy.ts`, `crm/src/components/portal/Portal.tsx` (`navFor`, selo do papel, redirecionamento da linha 62), `crm/src/app/api/team/route.ts` (POST aceita `DESIGNER`), `crm/src/app/api/team/[id]/route.ts:42` (PATCH aceita `DESIGNER`), `crm/src/components/admin/TeamView.tsx` (opção "Designer" no seletor de papel)
- Modify: `crm/tests/banco.ts` (`limparBanco` com `design_jobs`)
- Test: `crm/tests/papelDesigner.test.ts`

**Interfaces:**
- Produces: `Role = "ADMIN" | "COLABORADOR" | "DESIGNER"`; `homeFor("DESIGNER") === "/app/design"`.

- [ ] **Step 1: teste que falha**

`crm/tests/papelDesigner.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { homeFor, signSession, verifySession } from "@/lib/auth/token";
import { criarUsuario, limparBanco } from "./banco";

describe("papel DESIGNER", () => {
  beforeEach(limparBanco);
  it("o banco aceita o papel e as tabelas de design existem", async () => {
    const id = await criarUsuario({ role: "DESIGNER" });
    expect(id).toBeTruthy();
    const t = await query<{ n: number }>("SELECT COUNT(*)::int AS n FROM design_jobs");
    expect(t[0].n).toBe(0);
  });
  it("o token aceita DESIGNER e a casa dele é o quadro", async () => {
    const token = await signSession({ sub: "00000000-0000-0000-0000-000000000001", role: "DESIGNER", v: 0, pwd: false });
    expect((await verifySession(token))?.role).toBe("DESIGNER");
    expect(homeFor("DESIGNER")).toBe("/app/design");
  });
});
```
Confira a assinatura real de `signSession` em `token.ts` e ajuste a chamada.

- [ ] **Step 2: rodar e ver falhar** — `cd crm && npx vitest run tests/papelDesigner.test.ts` → FAIL (CHECK de `role`).

- [ ] **Step 3: implementar**
  - `006_design.sql`: copie o bloco SQL da spec seção 5 sem mudar nada.
  - `types.ts` e `token.ts`: `Role` ganha `"DESIGNER"`; `verifySession` aceita os 3 papéis; `homeFor`: `ADMIN → /admin/inicio`, `DESIGNER → /app/design`, resto `/app/inicio`.
  - `proxy.ts`: com `claims.role === "DESIGNER"` em `/app/*`, só passam `/app/design` (e subrotas) e `/app/conta`; o resto redireciona para `/app/design`. Atualize o comentário do topo (`/app/* → COLABORADOR e DESIGNER`).
  - `Portal.tsx`: `navFor("DESIGNER")` devolve só `Design` (`/app/design`, ícone `palette`) e `Conta`; o `ADMIN` ganha `Design` (`/admin/design`) no grupo de `CRM`/`Quadros`; o `COLABORADOR` não (a rota `GET /api/design` só aceita `ADMIN` e `DESIGNER`, spec 10.1). O redirecionamento da linha 62 usa `homeFor(user.role)`. Selo: `DESIGNER` com ícone `palette`.
  - `app/app/layout.tsx` passa `role="COLABORADOR"` ao `Portal`, que compara `user.role !== role`: mude o `Portal` para aceitar `role: Role | Role[]` e passe `["COLABORADOR", "DESIGNER"]` no layout de `/app`.
  - `team/route.ts` POST: `role` aceita `"DESIGNER"`; `receives_leads` só é `true` para `COLABORADOR` (já é assim). `team/[id]/route.ts`: aceite `DESIGNER` na troca de papel; trocar para `DESIGNER` grava `receives_leads = false`.
  - `TeamView.tsx`: opção "Designer" no seletor de papel, ao lado de Colaborador e Admin.
  - `limparBanco`: `TRUNCATE design_jobs, notifications, ... CASCADE` e `UPDATE crm_settings SET last_assigned_user_id = NULL, last_designer_id = NULL WHERE id`.

- [ ] **Step 4: rodar** — `cd crm && npx vitest run && npm run typecheck` → PASS.

- [ ] **Step 5: commit** — `git commit -m "feat(crm): papel DESIGNER e tabelas do módulo design"`

### Task 3: armazém de arquivos e validação de upload

**Files:**
- Create: `crm/src/lib/arquivos.ts`
- Modify: `crm/.env.example` (bloco `R2_*` da spec seção 6), `crm/package.json` (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`)
- Test: `crm/tests/arquivos.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TipoArquivo = "png" | "jpeg" | "webp" | "pdf" | "svg";
  export const LIMITE_BYTES = 16 * 1024 * 1024;
  export const MIME: Record<TipoArquivo, string>;
  export function detectarTipo(bytes: Uint8Array): TipoArquivo | null;
  export function ehAnalisavel(t: TipoArquivo): boolean; // png, jpeg, webp
  export function chaveSegura(chave: string): boolean;
  export function assinar(chave: string, exp: number): string;            // HMAC-SHA256 base64url com AUTH_SECRET
  export function conferirAssinatura(chave: string, exp: number, sig: string, agora?: number): boolean;
  export interface Armazem { salvar(chave, bytes, mime): Promise<void>; ler(chave): Promise<Buffer>; urlTemporaria(chave, segundos?): Promise<string>; }
  export function armazem(): Armazem;
  export function urlAbsoluta(url: string): string; // modo disco devolve caminho relativo; isto prefixa http://127.0.0.1:<PORT|3200>
  ```

- [ ] **Step 1: testes que falham**

`crm/tests/arquivos.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { armazem, assinar, conferirAssinatura, detectarTipo } from "@/lib/arquivos";

const b = (...x: number[]) => Uint8Array.from(x);
const txt = (s: string) => new TextEncoder().encode(s);

describe("detectarTipo", () => {
  it("reconhece cada tipo pelos primeiros bytes", () => {
    expect(detectarTipo(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe("png");
    expect(detectarTipo(b(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
    expect(detectarTipo(txt("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(detectarTipo(txt("%PDF-1.7"))).toBe("pdf");
    expect(detectarTipo(txt("  <svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe("svg");
    expect(detectarTipo(txt('<?xml version="1.0"?>\n<svg/>'))).toBe("svg");
  });
  it("recusa vazio, extensão mentirosa e texto qualquer", () => {
    expect(detectarTipo(b())).toBeNull();
    expect(detectarTipo(txt("MZ\x90\0"))).toBeNull(); // .exe renomeado para .png
    expect(detectarTipo(txt("<html><svg/></html>"))).toBeNull();
    expect(detectarTipo(txt("RIFF\0\0\0\0WAVE"))).toBeNull();
  });
});

describe("assinatura do modo disco", () => {
  it("vale até expirar e não aceita adulteração", () => {
    const exp = 2_000_000_000;
    const sig = assinar("design/a/b.png", exp);
    expect(conferirAssinatura("design/a/b.png", exp, sig, exp * 1000 - 1)).toBe(true);
    expect(conferirAssinatura("design/a/b.png", exp, sig, exp * 1000 + 1)).toBe(false);
    expect(conferirAssinatura("design/a/c.png", exp, sig, 0)).toBe(false);
    expect(conferirAssinatura("design/a/b.png", exp + 1, sig, 0)).toBe(false);
  });
});

describe("armazém em disco", () => {
  beforeAll(() => {
    process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "arq-"));
    delete process.env.R2_BUCKET;
  });
  it("salva e lê", async () => {
    await armazem().salvar("design/j1/original-1.png", Buffer.from("abc"), "image/png");
    expect((await armazem().ler("design/j1/original-1.png")).toString()).toBe("abc");
  });
  it("recusa chave com .. ou barra invertida", async () => {
    await expect(armazem().salvar("design/../x.png", Buffer.from("a"), "image/png")).rejects.toThrow();
    await expect(armazem().ler("design\\x.png")).rejects.toThrow();
  });
  it("url temporária aponta para a rota assinada", async () => {
    const url = await armazem().urlTemporaria("design/j1/original-1.png");
    expect(url).toMatch(/^\/api\/design\/arquivo\?chave=design%2Fj1%2Foriginal-1\.png&exp=\d+&sig=/);
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — `npx vitest run tests/arquivos.test.ts` → FAIL.

- [ ] **Step 3: implementar** `crm/src/lib/arquivos.ts`:
```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type TipoArquivo = "png" | "jpeg" | "webp" | "pdf" | "svg";
export const LIMITE_BYTES = 16 * 1024 * 1024;
export const MIME: Record<TipoArquivo, string> = {
  png: "image/png", jpeg: "image/jpeg", webp: "image/webp", pdf: "application/pdf", svg: "image/svg+xml",
};
export const EXTENSAO: Record<TipoArquivo, string> = { png: "png", jpeg: "jpg", webp: "webp", pdf: "pdf", svg: "svg" };

export function detectarTipo(bytes: Uint8Array): TipoArquivo | null {
  const at = (i: number, ...x: number[]) => x.every((v, k) => bytes[i + k] === v);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  if (ascii(0, "%PDF")) return "pdf";
  const inicio = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^﻿/, "").trimStart();
  const semXml = inicio.replace(/^<\?xml[^>]*\?>\s*/, "");
  return semXml.startsWith("<svg") ? "svg" : null;
}

export const ehAnalisavel = (t: TipoArquivo) => t === "png" || t === "jpeg" || t === "webp";
export const chaveSegura = (chave: string) => chave.startsWith("design/") && !chave.includes("..") && !chave.includes("\\");

function segredo(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET não configurado.");
  return s;
}
export function assinar(chave: string, exp: number): string {
  return createHmac("sha256", segredo()).update(`${chave}.${exp}`).digest("base64url");
}
export function conferirAssinatura(chave: string, exp: number, sig: string, agora = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < agora) return false;
  const a = Buffer.from(assinar(chave, exp));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Armazem {
  salvar(chave: string, bytes: Buffer, mime: string): Promise<void>;
  ler(chave: string): Promise<Buffer>;
  urlTemporaria(chave: string, segundos?: number): Promise<string>;
}

function exigirChave(chave: string): void {
  if (!chaveSegura(chave)) throw new Error("Chave de arquivo inválida.");
}

const disco = (): Armazem => {
  const raiz = process.env.ARQUIVOS_DIR || join(process.cwd(), "data", "arquivos");
  return {
    async salvar(chave, bytes) {
      exigirChave(chave);
      await mkdir(dirname(join(raiz, chave)), { recursive: true });
      await writeFile(join(raiz, chave), bytes);
    },
    async ler(chave) {
      exigirChave(chave);
      return readFile(join(raiz, chave));
    },
    async urlTemporaria(chave, segundos = 600) {
      exigirChave(chave);
      const exp = Math.floor(Date.now() / 1000) + segundos;
      return `/api/design/arquivo?chave=${encodeURIComponent(chave)}&exp=${exp}&sig=${assinar(chave, exp)}`;
    },
  };
};

async function r2(): Promise<Armazem> {
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "" },
  });
  const Bucket = process.env.R2_BUCKET!;
  return {
    async salvar(chave, bytes, mime) {
      exigirChave(chave);
      await s3.send(new PutObjectCommand({ Bucket, Key: chave, Body: bytes, ContentType: mime }));
    },
    async ler(chave) {
      exigirChave(chave);
      const r = await s3.send(new GetObjectCommand({ Bucket, Key: chave }));
      return Buffer.from(await r.Body!.transformToByteArray());
    },
    async urlTemporaria(chave, segundos = 600) {
      exigirChave(chave);
      return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: chave }), { expiresIn: segundos });
    },
  };
}

// shortcut: o R2 não tem teste automático nem ensaio (sem credenciais até o Dudu responder); ensaiar quando a chave chegar
export function armazem(): Armazem {
  if (!process.env.R2_BUCKET) return disco();
  const pronto = r2();
  return {
    salvar: async (...a) => (await pronto).salvar(...a),
    ler: async (...a) => (await pronto).ler(...a),
    urlTemporaria: async (...a) => (await pronto).urlTemporaria(...a),
  };
}

export const urlAbsoluta = (url: string) => (url.startsWith("/") ? `http://127.0.0.1:${process.env.PORT || 3200}${url}` : url);
```

- [ ] **Step 4: instalar e rodar** — `cd crm && npm i @aws-sdk/client-s3@3 @aws-sdk/s3-request-presigner@3 && npx vitest run tests/arquivos.test.ts && npm run typecheck` → PASS.

- [ ] **Step 5: commit** — `git commit -m "feat(crm): armazém de arquivos do design (disco e R2) e validação por bytes"`

### Task 4: regras do job — abertura, etapas e rodízio

**Files:**
- Create: `crm/src/lib/design.ts`
- Test: `crm/tests/design.test.ts`

**Interfaces:**
- Consumes: `armazem`, `detectarTipo`, `ehAnalisavel`, `LIMITE_BYTES`, `MIME`, `EXTENSAO` (Task 3); `notify`, `logEvent` (`crm/src/lib/leads.ts`); `transaction`, `one`, `query`, `Executor` (`crm/src/lib/db.ts`).
- Produces:
  ```ts
  export type Etapa = "RECEBIDO" | "PROCESSANDO_IA" | "NA_FILA" | "EM_CRIACAO" | "AGUARDANDO_CLIENTE" | "AJUSTES" | "APROVADO" | "CANCELADO";
  export type Origem = "LIA" | "VENDEDOR" | "PEDIDO";
  export const ETAPAS_ABERTAS: Etapa[]; // tudo menos APROVADO e CANCELADO
  export const ETAPAS_MANUAIS: Etapa[]; // o que a rota /etapa aceita: PROCESSANDO_IA, EM_CRIACAO, AJUSTES, CANCELADO
  export class DesignError extends Error { constructor(msg: string, public status = 409) }
  export function podeTransitar(de: Etapa, para: Etapa): boolean;
  export async function abrirOuAnexar(p: { leadId: string; origem: Origem; requestedBy?: string | null; orderId?: string | null; motivo?: string; observacao?: string; prioridade?: "normal" | "alta"; imagens: { bytes: Buffer; nome: string }[] }): Promise<{ jobId: string; criado: boolean }>;
  export async function mudarEtapa(jobId: string, para: Etapa, atorId: string | null, dados?: Record<string, unknown>): Promise<void>; // recusa APROVADO e AGUARDANDO_CLIENTE (só os fluxos próprios)
  export async function mudarEtapaTx(tx: Executor, jobId: string, para: Etapa, atorId: string | null, dados?: Record<string, unknown>): Promise<void>; // interno, sem a recusa
  export async function atribuirDesigner(jobId: string): Promise<string | null>;
  export async function atribuirDesignerTx(tx: Executor, jobId: string): Promise<string | null>;
  export async function registrarEvento(tx: Executor, jobId: string, atorId: string | null, tipo: string, dados?: Record<string, unknown>): Promise<void>;
  ```

- [ ] **Step 1: testes que falham**

`crm/tests/design.test.ts` (fixtures de imagem com bytes mínimos; o detector só olha o começo):
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { one, query } from "@/lib/db";
import { DesignError, abrirOuAnexar, atribuirDesigner, mudarEtapa, podeTransitar } from "@/lib/design";
import type { Etapa } from "@/lib/design";
import { criarLead, criarUsuario, limparBanco } from "./banco";

export const PNG = { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), nome: "ref.png" };
export const PDF = { bytes: Buffer.from("%PDF-1.4"), nome: "logo.pdf" };
const job = (id: string) => one<{ stage: Etapa; ia_status: string; designer_id: string | null; ia_tentativas: number }>("SELECT * FROM design_jobs WHERE id = $1", [id]);

beforeAll(() => { process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "arq-")); });
beforeEach(limparBanco);

describe("transições", () => {
  const permitidas: Array<[Etapa, Etapa]> = [
    ["RECEBIDO", "PROCESSANDO_IA"], ["RECEBIDO", "NA_FILA"], ["PROCESSANDO_IA", "NA_FILA"], ["NA_FILA", "PROCESSANDO_IA"],
    ["NA_FILA", "EM_CRIACAO"], ["EM_CRIACAO", "AGUARDANDO_CLIENTE"], ["AJUSTES", "AGUARDANDO_CLIENTE"],
    ["AGUARDANDO_CLIENTE", "AJUSTES"], ["AGUARDANDO_CLIENTE", "APROVADO"],
    ...(["RECEBIDO", "PROCESSANDO_IA", "NA_FILA", "EM_CRIACAO", "AGUARDANDO_CLIENTE", "AJUSTES"] as Etapa[]).map((e) => [e, "CANCELADO"] as [Etapa, Etapa]),
  ];
  it.each(permitidas)("%s → %s permitida", (de, para) => expect(podeTransitar(de, para)).toBe(true));
  const invalidas: Array<[Etapa, Etapa]> = [
    ["RECEBIDO", "EM_CRIACAO"], ["PROCESSANDO_IA", "EM_CRIACAO"], ["NA_FILA", "AGUARDANDO_CLIENTE"], ["EM_CRIACAO", "APROVADO"],
    ["AGUARDANDO_CLIENTE", "EM_CRIACAO"], ["AJUSTES", "APROVADO"], ["APROVADO", "CANCELADO"], ["CANCELADO", "NA_FILA"],
  ];
  it.each(invalidas)("%s → %s recusada", (de, para) => expect(podeTransitar(de, para)).toBe(false));

  it("mudarEtapa inválida lança DesignError e não grava", async () => {
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] }); // NA_FILA
    await expect(mudarEtapa(jobId, "AJUSTES", null)).rejects.toBeInstanceOf(DesignError);
    expect((await job(jobId))!.stage).toBe("NA_FILA");
  });
  it("mudarEtapa pública recusa APROVADO e AGUARDANDO_CLIENTE", async () => {
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    await mudarEtapa(jobId, "EM_CRIACAO", null);
    await expect(mudarEtapa(jobId, "AGUARDANDO_CLIENTE", null)).rejects.toBeInstanceOf(DesignError);
  });
});

describe("abrirOuAnexar", () => {
  it("com imagem analisável vai para PROCESSANDO_IA e grava o original", async () => {
    const lead = await criarLead();
    const r = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [PNG], motivo: "referencia_uniforme" });
    expect(r.criado).toBe(true);
    expect((await job(r.jobId))!.stage).toBe("PROCESSANDO_IA");
    const assets = await query<{ tipo: string; arquivo: string }>("SELECT tipo, arquivo FROM design_assets WHERE job_id = $1", [r.jobId]);
    expect(assets).toHaveLength(1);
    expect(assets[0].arquivo).toMatch(new RegExp(`^design/${r.jobId}/original-[0-9a-f-]+\\.png$`));
  });
  it("sem imagem analisável vai para NA_FILA com SEM_IMAGEM", async () => {
    const lead = await criarLead();
    const r = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [PDF] });
    const j = (await job(r.jobId))!;
    expect([j.stage, j.ia_status]).toEqual(["NA_FILA", "SEM_IMAGEM"]);
  });
  it("arquivo com tipo inválido é recusado inteiro", async () => {
    const lead = await criarLead();
    await expect(abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [{ bytes: Buffer.from("MZ"), nome: "x.png" }] })).rejects.toBeInstanceOf(DesignError);
    expect((await query("SELECT 1 FROM design_jobs")).length).toBe(0);
  });
  it("imagem nova em job não assumido volta para PROCESSANDO_IA e zera tentativas", async () => {
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    await query("UPDATE design_jobs SET ia_tentativas = 2 WHERE id = $1", [jobId]);
    const r = await abrirOuAnexar({ leadId: lead, origem: "LIA", imagens: [PNG] });
    expect(r).toEqual({ jobId, criado: false });
    const j = (await job(jobId))!;
    expect([j.stage, j.ia_tentativas]).toEqual(["PROCESSANDO_IA", 0]);
  });
  it("imagem nova em EM_CRIACAO só anexa e avisa o designer", async () => {
    const d = await criarUsuario({ role: "DESIGNER" });
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    await mudarEtapa(jobId, "EM_CRIACAO", d);
    await abrirOuAnexar({ leadId: lead, origem: "LIA", imagens: [PNG] });
    expect((await job(jobId))!.stage).toBe("EM_CRIACAO");
    const n = await query<{ title: string }>("SELECT title FROM notifications WHERE user_id = $1", [d]);
    expect(n.map((x) => x.title)).toContain("Cliente mandou imagem nova");
  });
  it("dois abrirOuAnexar ao mesmo tempo geram um job só", async () => {
    const lead = await criarLead();
    const [a, b] = await Promise.all([
      abrirOuAnexar({ leadId: lead, origem: "LIA", imagens: [] }),
      abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] }),
    ]);
    expect(a.jobId).toBe(b.jobId);
    expect((await query("SELECT 1 FROM design_jobs")).length).toBe(1);
  });
  it("job novo guarda o modo anterior do lead no evento criado", async () => {
    const lead = await criarLead({ agentMode: "humano" });
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    const [e] = await query<{ dados: { modo_anterior: string } }>("SELECT dados FROM design_events WHERE job_id = $1 AND tipo = 'criado'", [jobId]);
    expect(e.dados.modo_anterior).toBe("humano");
  });
});

describe("rodízio do designer", () => {
  it("dois designers alternam", async () => {
    const d1 = await criarUsuario({ role: "DESIGNER" });
    const d2 = await criarUsuario({ role: "DESIGNER" });
    const ids: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const lead = await criarLead();
      const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] }); // NA_FILA atribui
      ids.push((await job(jobId))!.designer_id);
    }
    expect(ids).toEqual([d1, d2, d1]);
  });
  it("sem designer ativo, notifica os admins e o job fica sem designer", async () => {
    const admin = await criarUsuario({ role: "ADMIN" });
    const lead = await criarLead();
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    expect((await job(jobId))!.designer_id).toBeNull();
    expect((await query("SELECT 1 FROM notifications WHERE user_id = $1", [admin])).length).toBe(1);
    expect(await atribuirDesigner(jobId)).toBeNull();
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — `npx vitest run tests/design.test.ts` → FAIL.

- [ ] **Step 3: implementar** `crm/src/lib/design.ts` (parte 1):
```ts
import { randomUUID } from "node:crypto";
import { one, query, transaction } from "@/lib/db";
import type { Executor } from "@/lib/db";
import { notify } from "@/lib/leads";
import { EXTENSAO, LIMITE_BYTES, MIME, armazem, detectarTipo, ehAnalisavel } from "@/lib/arquivos";
import type { TipoArquivo } from "@/lib/arquivos";

export type Etapa = "RECEBIDO" | "PROCESSANDO_IA" | "NA_FILA" | "EM_CRIACAO" | "AGUARDANDO_CLIENTE" | "AJUSTES" | "APROVADO" | "CANCELADO";
export type Origem = "LIA" | "VENDEDOR" | "PEDIDO";
export const ETAPAS_ABERTAS: Etapa[] = ["RECEBIDO", "PROCESSANDO_IA", "NA_FILA", "EM_CRIACAO", "AGUARDANDO_CLIENTE", "AJUSTES"];
export const ETAPAS_MANUAIS: Etapa[] = ["PROCESSANDO_IA", "EM_CRIACAO", "AJUSTES", "CANCELADO"];
const NAO_ASSUMIDAS: Etapa[] = ["RECEBIDO", "PROCESSANDO_IA", "NA_FILA"];

export class DesignError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

const TRANSICOES: Record<Etapa, Etapa[]> = {
  RECEBIDO: ["PROCESSANDO_IA", "NA_FILA"],
  PROCESSANDO_IA: ["NA_FILA"],
  NA_FILA: ["PROCESSANDO_IA", "EM_CRIACAO"],
  EM_CRIACAO: ["AGUARDANDO_CLIENTE"],
  AJUSTES: ["AGUARDANDO_CLIENTE"],
  AGUARDANDO_CLIENTE: ["AJUSTES", "APROVADO"],
  APROVADO: [],
  CANCELADO: [],
};
export const podeTransitar = (de: Etapa, para: Etapa) =>
  TRANSICOES[de].includes(para) || (para === "CANCELADO" && ETAPAS_ABERTAS.includes(de));

export async function registrarEvento(tx: Executor, jobId: string, atorId: string | null, tipo: string, dados: Record<string, unknown> = {}) {
  await tx.query("INSERT INTO design_events (job_id, actor_id, tipo, dados) VALUES ($1, $2, $3, $4)", [jobId, atorId, tipo, JSON.stringify(dados)]);
}

type ImagemValida = { bytes: Buffer; nome: string; tipo: TipoArquivo };
function validarImagens(imagens: { bytes: Buffer; nome: string }[]): ImagemValida[] {
  return imagens.map((i) => {
    if (i.bytes.length === 0 || i.bytes.length > LIMITE_BYTES) throw new DesignError(`Arquivo ${i.nome}: vazio ou maior que 16 MB.`, 400);
    const tipo = detectarTipo(i.bytes);
    if (!tipo) throw new DesignError(`Arquivo ${i.nome}: tipo não aceito (PNG, JPEG, WEBP, PDF ou SVG).`, 400);
    return { ...i, tipo };
  });
}

export async function salvarAsset(tx: Executor, jobId: string, tipoAsset: string, img: { bytes: Buffer; nome?: string; tipo: TipoArquivo }, versao = 1): Promise<string> {
  const chave = `design/${jobId}/${tipoAsset.toLowerCase().replace("_", "-")}-${randomUUID()}.${EXTENSAO[img.tipo]}`;
  // shortcut: o arquivo é gravado antes do COMMIT; um rollback raro deixa o arquivo órfão no armazém, sem linha
  await armazem().salvar(chave, img.bytes, MIME[img.tipo]);
  await tx.query(
    "INSERT INTO design_assets (job_id, tipo, arquivo, mime, bytes, meta, versao) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [jobId, tipoAsset, chave, MIME[img.tipo], img.bytes.length, JSON.stringify(img.nome ? { nome: img.nome } : {}), versao]
  );
  return chave;
}

type JobRow = { id: string; lead_id: string; stage: Etapa; designer_id: string | null; conversa_com_designer: boolean };

export async function abrirOuAnexar(p: {
  leadId: string; origem: Origem; requestedBy?: string | null; orderId?: string | null;
  motivo?: string; observacao?: string; prioridade?: "normal" | "alta"; imagens: { bytes: Buffer; nome: string }[];
}): Promise<{ jobId: string; criado: boolean }> {
  const imagens = validarImagens(p.imagens);
  const analisavel = imagens.some((i) => ehAnalisavel(i.tipo));
  const tentar = () => transaction(async (tx) => {
    let [job] = await tx.query<JobRow>(
      "SELECT id, lead_id, stage, designer_id, conversa_com_designer FROM design_jobs WHERE lead_id = $1 AND stage NOT IN ('APROVADO','CANCELADO') FOR UPDATE",
      [p.leadId]
    );
    const criado = !job;
    if (!job) {
      const [lead] = await tx.query<{ agent_mode: string }>("SELECT agent_mode FROM leads WHERE id = $1", [p.leadId]);
      if (!lead) throw new DesignError("Lead não encontrado.", 404);
      [job] = await tx.query<JobRow>(
        `INSERT INTO design_jobs (lead_id, order_id, requested_by, origem, prioridade) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, lead_id, stage, designer_id, conversa_com_designer`,
        [p.leadId, p.orderId ?? null, p.requestedBy ?? null, p.origem, p.prioridade ?? "normal"]
      );
      await registrarEvento(tx, job.id, p.requestedBy ?? null, "criado", { origem: p.origem, modo_anterior: lead.agent_mode });
    } else if (p.orderId) {
      await tx.query("UPDATE design_jobs SET order_id = COALESCE(order_id, $2) WHERE id = $1", [job.id, p.orderId]);
    }
    for (const img of imagens) {
      await salvarAsset(tx, job.id, "ORIGINAL", img);
      await registrarEvento(tx, job.id, p.requestedBy ?? null, "imagem_anexada", { nome: img.nome, tipo: img.tipo });
    }
    const nota = [p.motivo, p.observacao].filter(Boolean).join(": ");
    if (nota) await tx.query("UPDATE design_jobs SET briefing = CASE WHEN briefing IS NULL THEN $2 ELSE briefing || E'\\n' || $2 END WHERE id = $1", [job.id, nota]);

    if (criado) {
      if (analisavel) await mudarEtapaTx(tx, job.id, "PROCESSANDO_IA", null);
      else {
        await tx.query("UPDATE design_jobs SET ia_status = 'SEM_IMAGEM' WHERE id = $1", [job.id]);
        await mudarEtapaTx(tx, job.id, "NA_FILA", null);
      }
    } else if (analisavel && NAO_ASSUMIDAS.includes(job.stage)) {
      await tx.query("UPDATE design_jobs SET ia_tentativas = 0, ia_status = 'PENDENTE', ia_proxima_tentativa_em = NULL WHERE id = $1", [job.id]);
      if (job.stage !== "PROCESSANDO_IA") await mudarEtapaTx(tx, job.id, "PROCESSANDO_IA", null);
    } else if (imagens.length && job.designer_id) {
      await notify(tx, job.designer_id, "Cliente mandou imagem nova", "Chegou arquivo novo num job seu.", `/app/design/${job.id}`);
    }
    return { jobId: job.id, criado };
  });
  try {
    return await tentar();
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return tentar(); // dois gatilhos juntos: o índice único barrou o segundo
    throw err;
  }
}

export async function mudarEtapaTx(tx: Executor, jobId: string, para: Etapa, atorId: string | null, dados: Record<string, unknown> = {}) {
  const [job] = await tx.query<JobRow>("SELECT id, lead_id, stage, designer_id, conversa_com_designer FROM design_jobs WHERE id = $1 FOR UPDATE", [jobId]);
  if (!job) throw new DesignError("Job não encontrado.", 404);
  if (!podeTransitar(job.stage, para)) throw new DesignError(`Não dá para ir de ${job.stage} para ${para}.`);
  const extra = para === "PROCESSANDO_IA" ? ", ia_tentativas = 0, ia_status = 'PENDENTE', ia_proxima_tentativa_em = NULL"
    : para === "AJUSTES" ? ", confirmacao_pedida_em = NULL, confirmacao_versao = NULL" : "";
  await tx.query(`UPDATE design_jobs SET stage = $2, updated_at = NOW()${extra} WHERE id = $1`, [jobId, para]);
  await registrarEvento(tx, jobId, atorId, "etapa", { de: job.stage, para, ...dados });
  if (para === "NA_FILA" && !job.designer_id) await atribuirDesignerTx(tx, jobId);
}

export async function mudarEtapa(jobId: string, para: Etapa, atorId: string | null, dados?: Record<string, unknown>) {
  if (para === "APROVADO" || para === "AGUARDANDO_CLIENTE") throw new DesignError("Esta etapa tem fluxo próprio.");
  if (para === "CANCELADO") return cancelar(jobId, atorId); // Task 5
  await transaction((tx) => mudarEtapaTx(tx, jobId, para, atorId, dados));
}

export async function atribuirDesignerTx(tx: Executor, jobId: string): Promise<string | null> {
  const [settings] = await tx.query<{ last_designer_id: string | null }>("SELECT last_designer_id FROM crm_settings WHERE id FOR UPDATE");
  const designers = await tx.query<{ id: string }>("SELECT id FROM users WHERE role = 'DESIGNER' AND is_active ORDER BY created_at, id");
  const [info] = await tx.query<{ nome: string; designer_id: string | null }>(
    "SELECT COALESCE(l.name, 'cliente') AS nome, j.designer_id FROM design_jobs j JOIN leads l ON l.id = j.lead_id WHERE j.id = $1", [jobId]
  );
  if (info.designer_id) return info.designer_id;
  if (designers.length === 0) {
    const admins = await tx.query<{ id: string }>("SELECT id FROM users WHERE role = 'ADMIN' AND is_active");
    for (const a of admins) await notify(tx, a.id, "Job de design sem designer", `Novo job de ${info.nome}: não há designer ativo para receber.`, `/admin/design/${jobId}`);
    return null;
  }
  const last = designers.findIndex((d) => d.id === settings?.last_designer_id);
  const next = designers[(last + 1) % designers.length].id;
  await tx.query("UPDATE crm_settings SET last_designer_id = $1, updated_at = NOW() WHERE id", [next]);
  await tx.query("UPDATE design_jobs SET designer_id = $2, updated_at = NOW() WHERE id = $1", [jobId, next]);
  await registrarEvento(tx, jobId, null, "atribuido", { designer_id: next });
  await notify(tx, next, "Novo job de design", `Novo job de design: ${info.nome}`, `/app/design/${jobId}`);
  return next;
}

export const atribuirDesigner = (jobId: string) => transaction((tx) => atribuirDesignerTx(tx, jobId));
```
Os testes chamam `cancelar` só na Task 5; até lá, defina `async function cancelar(jobId: string, atorId: string | null) { await transaction((tx) => mudarEtapaTx(tx, jobId, "CANCELADO", atorId)); }` e a Task 5 completa.

- [ ] **Step 4: rodar** — `npx vitest run tests/design.test.ts && npm run typecheck` → PASS. Se o `pglite` reclamar de `gen_random_uuid`, confira a versão (0.3.x tem).

- [ ] **Step 5: commit** — `git commit -m "feat(crm): abertura de job, etapas e rodízio do designer"`

### Task 5: mockup, envio, dupla confirmação e devolução

**Files:**
- Modify: `crm/src/lib/design.ts`
- Modify: `crm/src/lib/ingest.ts` (`ingestLiveMessage`, linhas ~454–523)
- Test: `crm/tests/designConfirmacao.test.ts`

**Interfaces:**
- Consumes: Task 4; `callPonte` (`crm/src/lib/whatsapp.ts`); `armazem().urlTemporaria`, `urlAbsoluta` (Task 3).
- Produces:
  ```ts
  export const LEGENDA_CONFIRMACAO: (versao: number) => string;
  export function ehAprovacao(texto: string): boolean;
  export async function anexarMockup(jobId: string, arquivo: { bytes: Buffer; nome: string }, atorId: string): Promise<{ versao: number }>;
  export async function enviarMockup(jobId: string, versao: number, legenda: string, atorId: string): Promise<void>;
  export async function pedirConfirmacao(jobId: string, atorId: string): Promise<void>;
  export async function receberRespostaDoCliente(leadId: string, texto: string): Promise<"aprovado" | "nao_confirmou" | "sem_confirmacao_pendente">;
  export async function devolverAoAtendimento(jobId: string, atorId: string | null, nota?: string): Promise<void>;
  export async function designerDaConversa(tx: Executor, leadId: string): Promise<string | null>; // job aberto com conversa_com_designer
  ```

- [ ] **Step 1: testes que falham**

`crm/tests/designConfirmacao.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ponte = vi.hoisted(() => ({ chamadas: [] as Array<{ path: string; body: unknown }>, falhar: new Set<string>() }));
vi.mock("@/lib/whatsapp", () => ({
  callPonte: async (path: string, body: unknown) => {
    ponte.chamadas.push({ path, body });
    return ponte.falhar.has(path) ? { ok: false, status: 503, error: "fora", offline: true } : { ok: true, data: { id: "msg-1" } };
  },
}));

import { one, query } from "@/lib/db";
import { ingestLiveMessage } from "@/lib/ingest";
import {
  DesignError, abrirOuAnexar, anexarMockup, ehAprovacao, enviarMockup, mudarEtapa, pedirConfirmacao, receberRespostaDoCliente,
} from "@/lib/design";
import { criarLead, criarUsuario, limparBanco } from "./banco";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const etapa = async (id: string) => (await one<{ stage: string }>("SELECT stage FROM design_jobs WHERE id = $1", [id]))!.stage;

beforeAll(() => { process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "arq-")); });
beforeEach(async () => { await limparBanco(); ponte.chamadas = []; ponte.falhar.clear(); });

describe("ehAprovacao", () => {
  it.each(["APROVO", " aprovo! ", "Aprovó", "aprovo."])("%s aprova", (t) => expect(ehAprovacao(t)).toBe(true));
  it.each(["aprovo sim", "ok", "pode ser", "👍", "", "não aprovo"])("%s não aprova", (t) => expect(ehAprovacao(t)).toBe(false));
});

async function jobAguardando() {
  const d = await criarUsuario({ role: "DESIGNER" });
  const vendedor = await criarUsuario({ role: "COLABORADOR" });
  const lead = await criarLead({ assignedTo: vendedor });
  const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", requestedBy: vendedor, imagens: [] });
  await mudarEtapa(jobId, "EM_CRIACAO", d);
  const { versao } = await anexarMockup(jobId, { bytes: PNG, nome: "v1.png" }, d);
  await enviarMockup(jobId, versao, "Segue a arte", d);
  return { d, vendedor, lead, jobId };
}

describe("mockup e envio", () => {
  it("versões sobem e o envio vai pela /enviar-midia, liga a conversa com o designer e pausa a Lia", async () => {
    const { lead, jobId } = await jobAguardando();
    expect(await etapa(jobId)).toBe("AGUARDANDO_CLIENTE");
    const envio = ponte.chamadas.find((c) => c.path === "/enviar-midia")!.body as { url: string; legenda: string };
    expect(envio.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/design\/arquivo\?/);
    expect(envio.legenda).toBe("Segue a arte");
    const j = await one<{ conversa_com_designer: boolean }>("SELECT conversa_com_designer FROM design_jobs WHERE id = $1", [jobId]);
    expect(j!.conversa_com_designer).toBe(true);
    expect((await one<{ agent_mode: string }>("SELECT agent_mode FROM leads WHERE id = $1", [lead]))!.agent_mode).toBe("humano");
  });
  it("mockup que não é imagem é recusado", async () => {
    const d = await criarUsuario({ role: "DESIGNER" });
    const { jobId } = await abrirOuAnexar({ leadId: await criarLead(), origem: "VENDEDOR", imagens: [] });
    await mudarEtapa(jobId, "EM_CRIACAO", d);
    await expect(anexarMockup(jobId, { bytes: Buffer.from("%PDF-1.4"), nome: "a.pdf" }, d)).rejects.toBeInstanceOf(DesignError);
  });
  it("ponte fora no envio não muda a etapa", async () => {
    const d = await criarUsuario({ role: "DESIGNER" });
    const { jobId } = await abrirOuAnexar({ leadId: await criarLead(), origem: "VENDEDOR", imagens: [] });
    await mudarEtapa(jobId, "EM_CRIACAO", d);
    const { versao } = await anexarMockup(jobId, { bytes: PNG, nome: "v1.png" }, d);
    ponte.falhar.add("/enviar-midia");
    await expect(enviarMockup(jobId, versao, "x", d)).rejects.toBeInstanceOf(DesignError);
    expect(await etapa(jobId)).toBe("EM_CRIACAO");
  });
});

describe("dupla confirmação", () => {
  it("sem confirmação pendente, nada acontece", async () => {
    const { lead, jobId } = await jobAguardando();
    expect(await receberRespostaDoCliente(lead, "APROVO")).toBe("sem_confirmacao_pendente");
    expect(await etapa(jobId)).toBe("AGUARDANDO_CLIENTE");
  });
  it("'ok' não aprova, registra a prova e avisa o designer; 'APROVO' aprova", async () => {
    const { d, lead, jobId } = await jobAguardando();
    await pedirConfirmacao(jobId, d);
    const legenda = (ponte.chamadas.filter((c) => c.path === "/enviar-midia").at(-1)!.body as { legenda: string }).legenda;
    expect(legenda).toContain("versão 1");
    expect(legenda).toContain("APROVO");

    expect(await receberRespostaDoCliente(lead, "ok")).toBe("nao_confirmou");
    expect(await etapa(jobId)).toBe("AGUARDANDO_CLIENTE");
    const avisos = await query<{ title: string }>("SELECT title FROM notifications WHERE user_id = $1", [d]);
    expect(avisos.some((n) => /não confirmou/.test(n.title))).toBe(true);

    expect(await receberRespostaDoCliente(lead, "Aprovo!")).toBe("aprovado");
    expect(await etapa(jobId)).toBe("APROVADO");
    const provas = await query<{ dados: { texto: string; aprovou: boolean } }>(
      "SELECT dados FROM design_events WHERE job_id = $1 AND tipo = 'resposta_confirmacao' ORDER BY created_at", [jobId]);
    expect(provas.map((p) => [p.dados.texto, p.dados.aprovou])).toEqual([["ok", false], ["Aprovo!", true]]);
    expect((await query("SELECT 1 FROM design_assets WHERE job_id = $1 AND tipo = 'ARTE_FINAL'", [jobId])).length).toBe(1);
    expect(ponte.chamadas.some((c) => c.path === "/devolver")).toBe(true);
  });
  it("aprovação com pedido move o pedido para PRODUCAO com evento", async () => {
    const { d, lead, jobId } = await jobAguardando();
    const [o] = await query<{ id: string }>("INSERT INTO orders (lead_id, phone, title, stage, code) VALUES ($1, '5511900000099', 'x', 'ARTE', 'P-T1') RETURNING id", [lead]);
    await query("UPDATE design_jobs SET order_id = $2 WHERE id = $1", [jobId, o.id]);
    await pedirConfirmacao(jobId, d);
    await receberRespostaDoCliente(lead, "APROVO");
    expect((await one<{ stage: string }>("SELECT stage FROM orders WHERE id = $1", [o.id]))!.stage).toBe("PRODUCAO");
    expect((await query("SELECT 1 FROM order_events WHERE order_id = $1 AND to_stage = 'PRODUCAO'", [o.id])).length).toBe(1);
  });
  it("ajustes apagam a confirmação pendente", async () => {
    const { d, lead, jobId } = await jobAguardando();
    await pedirConfirmacao(jobId, d);
    await mudarEtapa(jobId, "AJUSTES", d);
    expect(await receberRespostaDoCliente(lead, "APROVO")).toBe("sem_confirmacao_pendente");
  });
  it("ponte fora na devolução não desfaz a aprovação e avisa o designer", async () => {
    const { d, lead, jobId } = await jobAguardando();
    await pedirConfirmacao(jobId, d);
    ponte.falhar.add("/devolver");
    expect(await receberRespostaDoCliente(lead, "APROVO")).toBe("aprovado");
    expect(await etapa(jobId)).toBe("APROVADO");
    const avisos = await query<{ title: string }>("SELECT title FROM notifications WHERE user_id = $1", [d]);
    expect(avisos.some((n) => /devolver/i.test(n.title))).toBe(true);
  });
  it("lead que já era humano antes do job não chama /devolver; avisa o vendedor", async () => {
    const d = await criarUsuario({ role: "DESIGNER" });
    const vendedor = await criarUsuario({ role: "COLABORADOR" });
    const lead = await criarLead({ assignedTo: vendedor, agentMode: "humano" });
    const { jobId } = await abrirOuAnexar({ leadId: lead, origem: "VENDEDOR", imagens: [] });
    await mudarEtapa(jobId, "EM_CRIACAO", d);
    const { versao } = await anexarMockup(jobId, { bytes: PNG, nome: "v1.png" }, d);
    await enviarMockup(jobId, versao, "x", d);
    await pedirConfirmacao(jobId, d);
    await receberRespostaDoCliente(lead, "APROVO");
    expect(ponte.chamadas.some((c) => c.path === "/devolver")).toBe(false);
    expect((await query("SELECT 1 FROM notifications WHERE user_id = $1", [vendedor])).length).toBeGreaterThan(0);
  });
});

describe("ingestLiveMessage com job de design", () => {
  it("cliente responde: aviso vai ao designer e o APROVO é conferido", async () => {
    const { d, lead, jobId } = await jobAguardando();
    await pedirConfirmacao(jobId, d);
    const phone = (await one<{ phone: string }>("SELECT phone FROM leads WHERE id = $1", [lead]))!.phone;
    await ingestLiveMessage({ id: "w-1", telefone: phone, autor: "CLIENTE", texto: "APROVO", timestamp: new Date().toISOString() });
    expect(await etapa(jobId)).toBe("APROVADO");
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — `npx vitest run tests/designConfirmacao.test.ts` → FAIL.

- [ ] **Step 3: implementar em `design.ts`**
```ts
import { callPonte } from "@/lib/whatsapp";
import { urlAbsoluta } from "@/lib/arquivos";
import { logEvent } from "@/lib/leads";

export const LEGENDA_CONFIRMACAO = (versao: number) =>
  `Para confirmar: esta é a arte final (versão ${versao}) que vai para produção. Depois de confirmada, ela não muda mais. Se estiver tudo certo, responda *APROVO*.`;

export function ehAprovacao(texto: string): boolean {
  const n = texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  return n === "aprovo";
}

async function jobParaAtor(tx: Executor, jobId: string) {
  const [j] = await tx.query<JobRow & { phone: string; assigned_to: string | null; order_id: string | null; confirmacao_versao: number | null }>(
    `SELECT j.id, j.lead_id, j.stage, j.designer_id, j.conversa_com_designer, j.order_id, j.confirmacao_versao, l.phone, l.assigned_to
     FROM design_jobs j JOIN leads l ON l.id = j.lead_id WHERE j.id = $1 FOR UPDATE OF j`, [jobId]);
  if (!j) throw new DesignError("Job não encontrado.", 404);
  return j;
}

export async function anexarMockup(jobId: string, arquivo: { bytes: Buffer; nome: string }, atorId: string) {
  const tipo = detectarTipo(arquivo.bytes);
  if (!tipo || !ehAnalisavel(tipo) || arquivo.bytes.length > LIMITE_BYTES) throw new DesignError("O mockup vai ao cliente como foto: envie PNG, JPEG ou WEBP de até 16 MB.", 400);
  return transaction(async (tx) => {
    const j = await jobParaAtor(tx, jobId);
    if (!["EM_CRIACAO", "AJUSTES", "AGUARDANDO_CLIENTE"].includes(j.stage)) throw new DesignError("Comece o job antes de subir o mockup.");
    const [{ v }] = await tx.query<{ v: number }>("SELECT COALESCE(MAX(versao), 0) + 1 AS v FROM design_assets WHERE job_id = $1 AND tipo = 'MOCKUP'", [jobId]);
    await salvarAsset(tx, jobId, "MOCKUP", { ...arquivo, tipo }, v);
    return { versao: v };
  });
}

async function chaveDoMockup(jobId: string, versao: number): Promise<string> {
  const a = await one<{ arquivo: string }>("SELECT arquivo FROM design_assets WHERE job_id = $1 AND tipo = 'MOCKUP' AND versao = $2", [jobId, versao]);
  if (!a) throw new DesignError("Versão do mockup não encontrada.", 404);
  return a.arquivo;
}

async function enviarImagemAoCliente(jobId: string, versao: number, legenda: string): Promise<string> {
  const j = await one<{ phone: string }>("SELECT l.phone FROM design_jobs j JOIN leads l ON l.id = j.lead_id WHERE j.id = $1", [jobId]);
  if (!j) throw new DesignError("Job não encontrado.", 404);
  const url = urlAbsoluta(await armazem().urlTemporaria(await chaveDoMockup(jobId, versao)));
  const r = await callPonte<{ id: string }>("/enviar-midia", { telefone: j.phone, url, legenda: legenda.slice(0, 1000) });
  if (!r.ok) throw new DesignError(r.error, r.status === 503 ? 503 : 502);
  return r.data.id;
}

export async function enviarMockup(jobId: string, versao: number, legenda: string, atorId: string) {
  const atual = await one<{ stage: Etapa }>("SELECT stage FROM design_jobs WHERE id = $1", [jobId]);
  if (!atual || !podeTransitar(atual.stage, "AGUARDANDO_CLIENTE")) throw new DesignError("O mockup só sai de Em criação ou Ajustes.");
  await enviarImagemAoCliente(jobId, versao, legenda); // ponte antes do banco, como a rota /enviar
  await transaction(async (tx) => {
    const j = await jobParaAtor(tx, jobId);
    await mudarEtapaTx(tx, jobId, "AGUARDANDO_CLIENTE", atorId);
    await tx.query("UPDATE design_jobs SET conversa_com_designer = true WHERE id = $1", [jobId]);
    await tx.query("UPDATE leads SET agent_mode = 'humano' WHERE id = $1", [j.lead_id]);
    await registrarEvento(tx, jobId, atorId, "mockup_enviado", { versao });
  });
}

export async function pedirConfirmacao(jobId: string, atorId: string) {
  const ultima = await one<{ versao: number }>(
    `SELECT (e.dados->>'versao')::int AS versao FROM design_events e WHERE e.job_id = $1 AND e.tipo = 'mockup_enviado' ORDER BY e.created_at DESC LIMIT 1`, [jobId]);
  const atual = await one<{ stage: Etapa }>("SELECT stage FROM design_jobs WHERE id = $1", [jobId]);
  if (atual?.stage !== "AGUARDANDO_CLIENTE" || !ultima) throw new DesignError("Só dá para pedir confirmação com o mockup enviado e aguardando o cliente.");
  const legenda = LEGENDA_CONFIRMACAO(ultima.versao);
  await enviarImagemAoCliente(jobId, ultima.versao, legenda);
  await transaction(async (tx) => {
    await tx.query("UPDATE design_jobs SET confirmacao_pedida_em = NOW(), confirmacao_versao = $2, updated_at = NOW() WHERE id = $1", [jobId, ultima.versao]);
    await registrarEvento(tx, jobId, atorId, "confirmacao_pedida", { versao: ultima.versao, texto: legenda });
  });
}

export async function receberRespostaDoCliente(leadId: string, texto: string) {
  const r = await transaction(async (tx) => {
    const [j] = await tx.query<{ id: string; designer_id: string | null; order_id: string | null; confirmacao_versao: number; assigned_to: string | null }>(
      `SELECT j.id, j.designer_id, j.order_id, j.confirmacao_versao, l.assigned_to FROM design_jobs j JOIN leads l ON l.id = j.lead_id
       WHERE j.lead_id = $1 AND j.stage = 'AGUARDANDO_CLIENTE' AND j.confirmacao_pedida_em IS NOT NULL FOR UPDATE OF j`, [leadId]);
    if (!j) return { resultado: "sem_confirmacao_pendente" as const };
    const aprovou = ehAprovacao(texto);
    await registrarEvento(tx, j.id, null, "resposta_confirmacao", { texto: texto.slice(0, 500), aprovou });
    if (!aprovou) {
      if (j.designer_id) await notify(tx, j.designer_id, "Cliente respondeu, mas não confirmou com APROVO", texto.slice(0, 120), `/app/design/${j.id}`);
      return { resultado: "nao_confirmou" as const };
    }
    await mudarEtapaTx(tx, j.id, "APROVADO", null);
    await tx.query(
      `INSERT INTO design_assets (job_id, tipo, arquivo, mime, bytes, meta, versao)
       SELECT job_id, 'ARTE_FINAL', arquivo, mime, bytes, meta, versao FROM design_assets WHERE job_id = $1 AND tipo = 'MOCKUP' AND versao = $2`,
      [j.id, j.confirmacao_versao]);
    await registrarEvento(tx, j.id, null, "aprovado", { versao: j.confirmacao_versao });
    if (j.order_id) {
      const [o] = await tx.query<{ stage: string }>("SELECT stage FROM orders WHERE id = $1 FOR UPDATE", [j.order_id]);
      if (o && o.stage !== "PRODUCAO") {
        await tx.query("UPDATE orders SET stage = 'PRODUCAO', stage_changed_at = NOW(), late_alert_at = NULL WHERE id = $1", [j.order_id]);
        await tx.query("INSERT INTO order_events (order_id, user_id, from_stage, to_stage) VALUES ($1, NULL, $2, 'PRODUCAO')", [j.order_id, o.stage]);
      }
    } else if (j.assigned_to) {
      await notify(tx, j.assigned_to, "Arte aprovada, falta o pedido", "O cliente aprovou a arte com APROVO.", `/app/crm?lead=${leadId}`);
    }
    return { resultado: "aprovado" as const, jobId: j.id };
  });
  if (r.resultado === "aprovado") await devolverAoAtendimento(r.jobId!, null);
  return r.resultado;
}

export async function devolverAoAtendimento(jobId: string, atorId: string | null, nota?: string) {
  const j = await one<{ lead_id: string; phone: string; designer_id: string | null; assigned_to: string | null; modo_anterior: string | null }>(
    `SELECT j.lead_id, l.phone, j.designer_id, l.assigned_to,
       (SELECT e.dados->>'modo_anterior' FROM design_events e WHERE e.job_id = j.id AND e.tipo = 'criado' LIMIT 1) AS modo_anterior
     FROM design_jobs j JOIN leads l ON l.id = j.lead_id WHERE j.id = $1`, [jobId]);
  if (!j) throw new DesignError("Job não encontrado.", 404);
  const voltaParaLia = j.modo_anterior !== "humano";
  const ponte = voltaParaLia ? await callPonte("/devolver", { telefone: j.phone, ...(nota ? { nota } : {}) }) : { ok: true as const };
  await transaction(async (tx) => {
    await tx.query("UPDATE design_jobs SET conversa_com_designer = false, updated_at = NOW() WHERE id = $1", [jobId]);
    if (!ponte.ok) {
      if (j.designer_id) await notify(tx, j.designer_id, "Não consegui devolver a conversa à Lia", "Use Devolver ao atendimento de novo.", `/app/design/${jobId}`);
      await registrarEvento(tx, jobId, atorId, "devolucao_falhou", {});
      return;
    }
    if (voltaParaLia) {
      await tx.query("UPDATE leads SET agent_mode = 'ia', needs_attention = false, attention_reason = NULL WHERE id = $1", [j.lead_id]);
      await logEvent(tx, j.lead_id, atorId, "ATENDIMENTO", { modo: "ia", ...(nota ? { nota } : {}) });
    } else if (j.assigned_to) {
      await notify(tx, j.assigned_to, "A conversa voltou para você", "O designer terminou o job de design.", `/app/crm?lead=${j.lead_id}`);
    }
    await registrarEvento(tx, jobId, atorId, "devolvido", { para: voltaParaLia ? "lia" : "vendedor" });
  });
}

async function cancelar(jobId: string, atorId: string | null) {
  const antes = await one<{ conversa_com_designer: boolean }>("SELECT conversa_com_designer FROM design_jobs WHERE id = $1", [jobId]);
  await transaction(async (tx) => {
    await mudarEtapaTx(tx, jobId, "CANCELADO", atorId);
    await registrarEvento(tx, jobId, atorId, "cancelado", {});
  });
  if (antes?.conversa_com_designer) await devolverAoAtendimento(jobId, atorId);
}

export async function designerDaConversa(tx: Executor, leadId: string): Promise<string | null> {
  const [j] = await tx.query<{ designer_id: string | null }>(
    "SELECT designer_id FROM design_jobs WHERE lead_id = $1 AND conversa_com_designer AND stage NOT IN ('APROVADO','CANCELADO')", [leadId]);
  return j?.designer_id ?? null;
}
```
O `TRANSICOES` não tem `APROVADO → ...`, e `devolverAoAtendimento` não muda etapa: devolver não passa por `mudarEtapaTx`. O botão "Devolver ao atendimento" (Task 10) só desliga a conversa com o designer.

Em `crm/src/lib/ingest.ts`, dentro de `ingestLiveMessage`:
- Na transação, troque o destinatário do aviso: `const designer = fromClient ? await designerDaConversa(tx, lead.id) : null;` e, se houver `designer`, notifique o designer (link `/app/design`) em vez do vendedor; o resto da condição (`agent_mode === 'humano'`, `unread_count === 0`) fica igual.
- Devolva `fromClient` e `kind` do resultado da transação. Depois dela, se `result.inserted && fromClient && kind === "texto"`, chame `await receberRespostaDoCliente(result.leadId, body)` dentro de `try/catch` com `console.error` (a mensagem já está gravada; erro no design não pode virar 500 na ponte, que reenviaria).
- Import circular: `design.ts` importa `leads.ts`, e `ingest.ts` importa `design.ts`. `design.ts` não importa `ingest.ts`, então não há ciclo.

- [ ] **Step 4: rodar** — `npx vitest run && npm run typecheck` → PASS.

- [ ] **Step 5: commit** — `git commit -m "feat(crm): mockup, envio ao cliente e aprovação com APROVO"`

### Task 6: acesso do `DESIGNER`

**Files:**
- Modify: `crm/src/lib/access.ts` (`requireUser`, `leadScope`)
- Modify: as rotas que o designer usa, passando `{ allowDesigner: true }`: `api/me`, `api/auth/*` (logout e password), `api/notifications`, `api/leads/route.ts` (GET), `api/leads/[id]/route.ts` (só GET), `api/leads/[id]/enviar`, todas as `api/design/*` (Task 9). `api/orders/[id]/route.ts` GET monta o escopo à mão (`l.assigned_to = $2`): continua barrando o designer pelo padrão.
- Test: `crm/tests/acesso.test.ts`

**Interfaces:**
- Produces: `requireUser(options?: { allowPendingPassword?: boolean; allowDesigner?: boolean })`; `barraDesigner(user: Pick<SessionUser, "role">, allowDesigner?: boolean): boolean`; `leadScope` com o ramo `DESIGNER`.

Por padrão o `DESIGNER` leva 403 em toda rota que não pediu `allowDesigner`: as rotas de funil, pedidos, relatórios, PresentesIA e equipe ficam fechadas sem mexer nelas uma a uma (spec 10.2).

- [ ] **Step 1: teste que falha** — `crm/tests/acesso.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { barraDesigner, leadScope } from "@/lib/access";
import { abrirOuAnexar } from "@/lib/design";
import { criarLead, criarUsuario, limparBanco } from "./banco";

beforeEach(limparBanco);

it("designer é barrado por padrão e liberado onde a rota pede", () => {
  expect(barraDesigner({ role: "DESIGNER" })).toBe(true);
  expect(barraDesigner({ role: "DESIGNER" }, true)).toBe(false);
  expect(barraDesigner({ role: "COLABORADOR" })).toBe(false);
});

it("leadScope do designer: vê o lead do job dele, não vê outro", async () => {
  const d = await criarUsuario({ role: "DESIGNER" });
  const meu = await criarLead();
  const outro = await criarLead();
  await abrirOuAnexar({ leadId: meu, origem: "VENDEDOR", imagens: [] }); // rodízio atribui ao único designer
  const params: unknown[] = [];
  const scope = leadScope({ id: d, role: "DESIGNER" } as never, params);
  const rows = await query<{ id: string }>(`SELECT l.id FROM leads l WHERE ${scope}`, params);
  expect(rows.map((r) => r.id)).toEqual([meu]);
  expect(rows.map((r) => r.id)).not.toContain(outro);
});
```
- [ ] **Step 2: rodar e ver falhar.**
- [ ] **Step 3: implementar**
```ts
export const barraDesigner = (user: Pick<SessionUser, "role">, allowDesigner = false) => user.role === "DESIGNER" && !allowDesigner;
// em requireUser, depois da checagem de senha:
if (barraDesigner(user, options.allowDesigner)) return { error: jsonError("Acesso restrito.", 403) };
// em leadScope:
if (user.role === "DESIGNER") {
  params.push(user.id);
  return `EXISTS (SELECT 1 FROM design_jobs j WHERE j.lead_id = ${alias}.id AND j.designer_id = $${params.length})`;
}
```
`requireAdmin` chama `requireUser()` sem a opção: continua barrando. Nas rotas listadas em **Files**, troque `requireUser()` por `requireUser({ allowDesigner: true })` (no `auth/password`, junte com o `allowPendingPassword` que já existe). No `PATCH` de `leads/[id]`, deixe sem a opção: o designer não mexe no funil.
- [ ] **Step 4: rodar** — `npx vitest run && npm run typecheck` → PASS. Confira com `grep -rn "requireUser(" crm/src/app/api` que só as rotas listadas ganharam a opção.
- [ ] **Step 5: commit** — `git commit -m "feat(crm): escopo e bloqueio padrão do papel DESIGNER"`

### Task 7: envio ao CRM, compartilhado pela ponte e pela Lia (agente)

**Files:**
- Create: `src/integrations/crm/design.ts` (P4)
- Test: `tests/encaminharParaDesign.test.ts`

**Interfaces:**
- Consumes: `config.crm.url`, `config.crm.segredo` (`src/config.ts`); `ArquivoRecebido` (`src/agent/state.ts:19`).
- Produces:
  ```ts
  export interface PedidoDesign { telefone: string; origem: "LIA" | "VENDEDOR"; motivo?: string; observacao?: string; prioridade?: "normal" | "alta"; requestedBy?: string; arquivos: ArquivoRecebido[] }
  export type Encaminhar = (p: PedidoDesign) => Promise<{ jobId: string; imagens: number }>;
  export function encaminharParaDesign(p: PedidoDesign): Promise<{ jobId: string; imagens: number }>;
  export function setEncaminharParaDesign(fn: Encaminhar | null): void; // null volta ao real
  ```

- [ ] **Step 1: teste que falha** — `tests/encaminharParaDesign.test.ts`: suba um `http.createServer` em `127.0.0.1:0` que guarda os cabeçalhos e o corpo e responde `{ jobId: "j1", criado: true }`; aponte `config.crm.url` para ele (mute o objeto `config` no `beforeAll` e restaure no `afterAll`); grave dois arquivos num diretório temporário. Casos:
  1. sucesso: `POST /api/integracao/design`, cabeçalho `x-crm-secret`, `content-type` `multipart/form-data`, os campos `telefone`, `origem`, `motivo` e duas partes `imagem`; devolve `{ jobId: "j1", imagens: 2 }`.
  2. arquivo que sumiu do disco é pulado (vai `imagens: 1`), sem lançar.
  3. CRM responde 500: lança `Error` com o status.
  4. CRM sem URL configurada: lança "CRM não configurado".
- [ ] **Step 2: rodar e ver falhar** — `npx vitest run tests/encaminharParaDesign.test.ts`.
- [ ] **Step 3: implementar**
```ts
import { readFile } from "node:fs/promises";
import { config } from "../../config.js";
import type { ArquivoRecebido } from "../../agent/state.js";

export interface PedidoDesign {
  telefone: string; origem: "LIA" | "VENDEDOR"; motivo?: string; observacao?: string;
  prioridade?: "normal" | "alta"; requestedBy?: string; arquivos: ArquivoRecebido[];
}
export type Encaminhar = (p: PedidoDesign) => Promise<{ jobId: string; imagens: number }>;

async function noCrm(p: PedidoDesign) {
  if (!config.crm.url || config.crm.segredo.length < 16) throw new Error("CRM não configurado.");
  const form = new FormData();
  form.set("telefone", p.telefone);
  form.set("origem", p.origem);
  for (const [k, v] of [["motivo", p.motivo], ["observacao", p.observacao], ["prioridade", p.prioridade], ["requested_by", p.requestedBy]] as const) {
    if (v) form.set(k, v);
  }
  let imagens = 0;
  for (const a of p.arquivos) {
    const bytes = await readFile(a.caminho).catch(() => null); // arquivo apagado do disco: segue com os outros
    if (!bytes) continue;
    form.append("imagem", new Blob([bytes], { type: a.mime }), a.nome);
    imagens++;
  }
  const res = await fetch(`${config.crm.url}/api/integracao/design`, {
    method: "POST", headers: { "x-crm-secret": config.crm.segredo }, body: form, signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`CRM respondeu ${res.status}`);
  const corpo = (await res.json()) as { jobId?: string };
  if (typeof corpo.jobId !== "string") throw new Error("CRM respondeu sem jobId");
  return { jobId: corpo.jobId, imagens };
}

let impl: Encaminhar = noCrm;
export const encaminharParaDesign: Encaminhar = (p) => impl(p);
export function setEncaminharParaDesign(fn: Encaminhar | null): void { impl = fn ?? noCrm; }
```
Em `tests/setup/semCrm.ts`, acrescente `setEncaminharParaDesign(async () => { throw new Error("CRM desligado nos testes"); });`, no mesmo espírito do histórico (o teste que precisa troca).
- [ ] **Step 4: rodar** — `npx vitest run tests/encaminharParaDesign.test.ts && npm run typecheck` → PASS.
- [ ] **Step 5: commit** — `git commit -m "feat(agente): envio de arquivos ao job de design do CRM"`

### Task 8: ponte — `/enviar-midia` e `/encaminhar-design`

**Files:**
- Modify: `src/whatsapp/controle.ts` (extrair o tratador; 2 rotas; comentário do topo)
- Modify: `src/whatsapp/sessao.ts` (novo `enviarImagemParaTelefone`, ao lado de `enviarTexto`, linha ~134)
- Modify: `src/whatsapp/index.ts:54` (passar `lerArquivos`)
- Test: `tests/controle.test.ts`

**Interfaces:**
- Consumes: `encaminharParaDesign` (Task 7); `PgConversas(banco).ler(telefone)` (como em `index.ts:45`; confira o formato que ele devolve e tire dele `estado.arquivosRecebidos`).
- Produces:
  ```ts
  // controle.ts
  export function tratadorControle(opcoes: OpcoesControle): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  // OpcoesControle = as de hoje + lerArquivos(telefone: string): Promise<ArquivoRecebido[]>
  // sessao.ts
  async enviarImagemParaTelefone(telefone: string, url: string, legenda: string): Promise<string>; // devolve o id
  ```

- [ ] **Step 1: teste que falha** — `tests/controle.test.ts`: `createServer(tratadorControle({...}))` em `127.0.0.1:0`, com `canal` falso (`situacao()` controlável, `enviarImagemParaTelefone` e `enviarTexto` como `vi.fn`), `ponte`, `lia` e `log` falsos, `lerArquivos` falso, segredo de 16+ caracteres, e `setEncaminharParaDesign` falso. Casos:
  1. `/enviar-midia` sem segredo → 401.
  2. `/enviar-midia` com telefone curto, sem `url`, `url` `ftp://`, `url` `http://exemplo.com` ou legenda com 1.001 caracteres → 400.
  3. `/enviar-midia` com WhatsApp `RECONECTANDO` → 409.
  4. `/enviar-midia` válido (`https://...` e `http://127.0.0.1:3200/...`) → 200 `{ id }`; `canal.enviarImagemParaTelefone` chamado com telefone só com dígitos; **nenhum** outro método de envio chamado (Review Focus 1: o `Envio`/registro de saída não entra nesta rota).
  5. `/encaminhar-design` com 2 arquivos em `lerArquivos` → 200 `{ jobId, imagens: 2 }`, e o falso recebeu `origem: "VENDEDOR"` e `requestedBy`.
  6. `/encaminhar-design` sem arquivos → chama com `arquivos: []`.
  7. `/encaminhar-design` com o CRM fora (falso lança) → 502 com `erro`.
- [ ] **Step 2: rodar e ver falhar.**
- [ ] **Step 3: implementar**
  - `controle.ts`: mova o corpo do `createServer(async (req, res) => {...})` para `export function tratadorControle(opcoes)`; `iniciarControle` passa a ser `createServer(tratadorControle(opcoes)).listen(...)`. Acrescente:
```ts
const urlAceita = (u: string) => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u);

if (req.method === "POST" && req.url === "/enviar-midia") {
  const corpo = await lerJson(req);
  const telefone = typeof corpo.telefone === "string" ? corpo.telefone.replace(/\D/g, "") : "";
  const url = typeof corpo.url === "string" ? corpo.url : "";
  const legenda = typeof corpo.legenda === "string" ? corpo.legenda : "";
  if (telefone.length < 10 || !urlAceita(url) || legenda.length > 1_000) return responder(res, 400, { erro: "telefone, url (https ou local) e legenda até 1.000 caracteres" });
  if (canal.situacao().estado !== "CONECTADO") return responder(res, 409, { erro: "O WhatsApp não está conectado." });
  // Fora do registro de saída de propósito: o eco chega como atendente e a Lia pausa
  const id = await canal.enviarImagemParaTelefone(telefone, url, legenda);
  return responder(res, 200, { id });
}
if (req.method === "POST" && req.url === "/encaminhar-design") {
  const corpo = await lerJson(req);
  const telefone = typeof corpo.telefone === "string" ? corpo.telefone.replace(/\D/g, "") : "";
  if (telefone.length < 10) return responder(res, 400, { erro: "telefone obrigatório" });
  const requestedBy = typeof corpo.requested_by === "string" ? corpo.requested_by : undefined;
  try {
    const r = await encaminharParaDesign({ telefone, origem: "VENDEDOR", requestedBy, arquivos: await opcoes.lerArquivos(telefone) });
    return responder(res, 200, r);
  } catch (err) {
    log({ type: "encaminhar_design_falhou", erro: String(err) });
    return responder(res, 502, { erro: "O CRM não recebeu o job de design." });
  }
}
```
  - `sessao.ts`, ao lado de `enviarTexto`:
```ts
async enviarImagemParaTelefone(telefone: string, url: string, legenda: string): Promise<string> {
  const cliente = this.exigirCliente();
  const numero = await cliente.getNumberId(telefone.replace(/\D/g, ""));
  if (!numero) throw new Error("Este número não tem WhatsApp.");
  const midia = await MessageMedia.fromUrl(url, { unsafeMime: true });
  const enviada = await cliente.sendMessage(numero._serialized, midia, { caption: legenda, sendSeen: false });
  if (!enviada) throw new Error("O WhatsApp não confirmou o envio.");
  return enviada.id._serialized;
}
```
  Confira se `CanalWwebjs` é uma interface separada da classe: se for, acrescente o método nela.
  - `index.ts`: `lerArquivos: async (t) => ((await new PgConversas(banco).ler(t)) as { estado?: { arquivosRecebidos?: ArquivoRecebido[] } } | null)?.estado?.arquivosRecebidos ?? []` (ajuste ao formato real que `ler` devolve). Sem banco (CRM desligado), `lerArquivos` devolve `[]`.
  - O tipo do log (`LogPonte`) aceita `type` livre? Se for união fechada, acrescente `encaminhar_design_falhou`.
- [ ] **Step 4: rodar** — `npx vitest run && npm run typecheck` (raiz, 1 worker se faltar memória: `--maxWorkers=1`) → PASS.
- [ ] **Step 5: commit** — `git commit -m "feat(ponte): rotas de envio de mockup e de encaminhamento ao design"`

### Task 9: rotas do CRM e gatilho `ARTE`

**Files:**
- Create: `crm/src/app/api/integracao/design/route.ts`
- Create: `crm/src/app/api/design/route.ts`, `crm/src/app/api/design/[id]/route.ts`, `.../[id]/etapa/route.ts`, `.../[id]/mockup/route.ts`, `.../[id]/enviar-mockup/route.ts`, `.../[id]/confirmar/route.ts`, `.../[id]/devolver/route.ts`, `.../[id]/assumir/route.ts`, `crm/src/app/api/design/arquivo/route.ts`
- Create: `crm/src/app/api/leads/[id]/design/route.ts`
- Modify: `crm/src/lib/design.ts` (leituras: `listarJobs`, `detalharJob`, `jobDoUsuario`, `assumir`, `jobAbertoDoLead`)
- Modify: `crm/src/app/api/leads/[id]/route.ts` (PATCH: gatilho), `crm/src/app/api/orders/route.ts` (POST: gatilho), `crm/src/app/api/orders/[id]/route.ts` (PATCH: gatilho)
- Test: `crm/tests/designLeituras.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces (em `design.ts`):
  ```ts
  export async function jobDoUsuario(jobId: string, user: { id: string; role: Role }): Promise<{ id: string; lead_id: string; designer_id: string | null; stage: Etapa } | null>; // ADMIN vê todos; DESIGNER só o dele (ou sem designer, para "Assumir")
  export async function listarJobs(user): Promise<CardJob[]>;   // abertos + APROVADO dos últimos 14 dias; designer só os dele
  export async function detalharJob(jobId: string): Promise<DetalheJob>; // job, assets com url (SVG só com download), eventos, últimas 50 mensagens
  export async function assumir(jobId: string, designerId: string): Promise<void>; // só com designer_id nulo
  export async function jobAbertoDoLead(leadId: string): Promise<{ id: string; stage: Etapa } | null>;
  export type CardJob = { id: string; lead_id: string; cliente: string; peca: string | null; prazo: string | null; prioridade: string; stage: Etapa; ia_status: string; miniatura: string | null };
  ```

- [ ] **Step 1: testes que falham** — `crm/tests/designLeituras.test.ts`:
  1. `listarJobs` do designer traz só os jobs dele; do admin, todos; aprovado há 15 dias some.
  2. `jobDoUsuario`: designer não acha job de outro designer (`null`); acha job sem designer; admin acha qualquer.
  3. `assumir` em job com designer lança `DesignError`; em job sem designer grava e registra `atribuido`.
  4. `detalharJob`: asset SVG sai com `download: true` e sem `miniatura`; PNG sai com `url` assinada.
- [ ] **Step 2: rodar e ver falhar.**
- [ ] **Step 3: implementar as leituras** (SQL direto em `design.ts`; `miniatura` = `urlTemporaria` do `ORIGINAL` analisável mais recente; `cliente` = `COALESCE(l.name, 'Cliente')`, nunca o telefone no card).
- [ ] **Step 4: implementar as rotas**, todas no molde de `leads/[id]/enviar/route.ts` (`requireUser`, `jsonError`, `serverError`, `DesignError → jsonError(err.message, err.status)`):
  - `integracao/design` POST: `integrationAuthorized` → 401; `request.formData()`; telefone só dígitos com 10+; acha o lead com `phoneVariants` (`orders.ts`) em `leads.phone`, sem lead → 404 (a ponte só encaminha conversa que já existe no CRM); `imagens = formData.getAll("imagem")` como `File` → `{ bytes: Buffer.from(await f.arrayBuffer()), nome: f.name }`, no máximo 10; `origem` só `LIA`/`VENDEDOR`; `requested_by` só se `isUuid`; `abrirOuAnexar`; responde `{ jobId, criado }`.
  - `design` GET (`allowDesigner`): `ADMIN` ou `DESIGNER`, senão 403; `listarJobs`.
  - `design/[id]` GET: `jobDoUsuario` → 404; `detalharJob`.
  - `[id]/etapa` POST `{ para }`: `para` em `ETAPAS_MANUAIS`, senão 400; `EM_CRIACAO`, `PROCESSANDO_IA` e `CANCELADO` exigem o designer atribuído ou admin (`jobDoUsuario` + `designer_id === user.id || ADMIN`); `mudarEtapa`.
  - `[id]/mockup` POST multipart, campo `arquivo` → `anexarMockup`.
  - `[id]/enviar-mockup` POST `{ versao, legenda }` (legenda até 1.000) → `enviarMockup`.
  - `[id]/confirmar` POST → `pedirConfirmacao`. `[id]/devolver` POST `{ nota? }` → `devolverAoAtendimento`. `[id]/assumir` POST, só `DESIGNER` → `assumir`.
  - `design/arquivo` GET: lê `chave`, `exp`, `sig`; `chaveSegura` e `conferirAssinatura` → 403; `armazem().ler`; `detectarTipo` dos bytes decide o `Content-Type`; SVG sai com `Content-Disposition: attachment` e `Content-Security-Policy: sandbox`; todos com `X-Content-Type-Options: nosniff` e `Cache-Control: private, max-age=600`. Sem login (P2).
  - `leads/[id]/design` POST (`ADMIN`/`COLABORADOR`, `getLeadForUser` → 404): com multipart e campo `imagem`, upload manual → `abrirOuAnexar({ origem: "VENDEDOR", requestedBy: user.id, imagens })`; sem arquivo → `callPonte("/encaminhar-design", { telefone: lead.phone, requested_by: user.id }, 40_000)`; ponte fora (`offline`) → abre o job sem imagens e responde `{ jobId, aviso: "A ponte está fora: o job abriu sem as imagens da conversa." }`.
  - Gatilho `ARTE`: em `leads/[id]` PATCH, depois da transação, se `stage === "ARTE" && lead.stage !== "ARTE"` → `abrirOuAnexar({ leadId: id, origem: "PEDIDO", requestedBy: user.id, imagens: [] })` em `try/catch` com `console.error` (a mudança de etapa já valeu). Em `orders/route.ts` POST e `orders/[id]` PATCH, mesma coisa quando o pedido entra em `ARTE` e tem `lead_id`, passando `orderId`.
- [ ] **Step 5: rodar** — `cd crm && npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 6: commit** — `git commit -m "feat(crm): rotas do módulo design e gatilho da etapa ARTE"`

### Task 10: telas — quadro, detalhe e `LeadPanel`

**Files:**
- Create: `crm/src/components/design/DesignBoard.tsx`, `crm/src/components/design/DesignJobView.tsx`, `crm/src/components/design/etapas.ts`
- Create: `crm/src/app/app/design/page.tsx`, `crm/src/app/app/design/[id]/page.tsx`, `crm/src/app/admin/design/page.tsx`, `crm/src/app/admin/design/[id]/page.tsx`
- Modify: `crm/src/components/crm/LeadPanel.tsx` (botão e selo)
- Modify: `crm/src/app/api/leads/[id]/route.ts` GET (devolve `design_job: jobAbertoDoLead(id)`)

**Interfaces:**
- Consumes: rotas da Task 9; `api()` de `crm/src/lib/client/api.ts`; componentes de `crm/src/components/ui.tsx` (`Button` e o que `BoardsView.tsx` usa); `usePortal()` (contexto do `Portal`, com `me`, `base`, `isAdmin`).
- Produces: `etapas.ts` com `COLUNAS` (Recebido inclui `PROCESSANDO_IA`; Na fila; Em criação; Aguardando cliente; Ajustes; Aprovado), `ROTULO_ETAPA`, `SELO_IA` e `botoesDaEtapa(stage, { souDesigner, isAdmin, semDesigner })` → lista de ações, espelho de `TRANSICOES`.

- [ ] **Step 1: teste de `botoesDaEtapa`** — `crm/tests/botoesDaEtapa.test.ts` (função pura): `NA_FILA` mostra Começar e Reprocessar IA; `EM_CRIACAO` mostra Enviar mockup e não mostra Cliente aprovou; `AGUARDANDO_CLIENTE` mostra Marcar ajustes e Cliente aprovou; `APROVADO` e `CANCELADO` não mostram nada; Assumir só com `semDesigner` e quem pede é designer; Cancelar em toda etapa aberta.
- [ ] **Step 2: rodar e ver falhar; implementar `etapas.ts`; rodar e ver passar.**
- [ ] **Step 3: `DesignBoard.tsx`** — no molde de `BoardsView.tsx` (mesma grade de colunas, mesmo card): `GET /api/design`, colunas de `COLUNAS`, card com miniatura (`<img src={miniatura}>` só quando houver; SVG nunca), cliente, `peca`, prazo, prioridade e selo (`IA ok`, `IA falhou`, `Sem imagem`, `Analisando...` para `PROCESSANDO_IA`). Clique abre `${base}/design/${id}`. Sem arrastar.
- [ ] **Step 4: `DesignJobView.tsx`** — `GET /api/design/[id]`, 3 colunas (empilhadas no celular):
  - esquerda: originais (`<img>` para PNG/JPEG/WEBP; PDF e SVG como link de download), ficha e briefing (com ficha vazia, mostra só o briefing; bboxes ficam para a Task 15);
  - centro: elementos e paleta (vazios na entrega 1: "Aguardando o kit da IA" ou "Sem imagem para analisar"), versões do mockup (`v1`, `v2`...) e upload de nova versão (`<input type="file" accept="image/png,image/jpeg,image/webp">` → `POST mockup`);
  - direita: últimas mensagens (só leitura), campo "Falar com o cliente" (`POST /api/leads/[lead_id]/enviar`; a rota liga o `conversa_com_designer`, Step 7), "Pedir arquivo em alta" (manda o texto fixo da spec 10.3 pela mesma rota `enviar`), e os botões de `botoesDaEtapa`, cada um chamando a rota da Task 9 e recarregando o job.
  - Erros das rotas aparecem no padrão de erro dos outros componentes.
- [ ] **Step 5: páginas** — `app/app/design/page.tsx` → `<DesignBoard />`, `[id]/page.tsx` → `<DesignJobView id={params.id} />`; o mesmo em `/admin/design`.
- [ ] **Step 6: `LeadPanel.tsx`** — para `ADMIN` e `COLABORADOR`: botão "Enviar para design" (`POST /api/leads/[id]/design`, mostra o `aviso` se vier) e, com `design_job`, selo com `ROTULO_ETAPA[stage]` e link `${base}/design/${id}`. Para `DESIGNER` o painel não mostra o botão.
- [ ] **Step 7: `ligarConversaComDesigner(leadId, designerId)`** em `design.ts` — teste em `designConfirmacao.test.ts` (liga a flag do job aberto do designer no lead; não liga job de outro designer) e implementação; em `enviar/route.ts`, depois do envio, se `guard.user.role === "DESIGNER"`, chame-a.
- [ ] **Step 8: rodar** — `cd crm && npx vitest run && npm run typecheck && npm run build` → PASS.
- [ ] **Step 9: commit** — `git commit -m "feat(crm): quadro e detalhe do job de design"`

### Task 11: validação da entrega 1

- [ ] **Step 1: ambiente** (só o necessário):
```bash
npm run db:subir
docker exec agente-banco psql -U postgres -c "CREATE DATABASE crm OWNER crm"
docker exec agente-banco psql -U postgres -c "CREATE DATABASE crm_teste OWNER crm"
```
  Em `crm/.env`: `DATABASE_URL=postgres://crm:crm@127.0.0.1:5440/crm`, `R2_*` vazias. Confira o `DATABASE_URL` antes de cada comando: nunca o do Neon. `cd crm && npm ci && npm run db:migrate && npm run admin:criar`.
- [ ] **Step 2: concorrência no Postgres de verdade** — `TEST_DATABASE_URL=postgres://crm:crm@127.0.0.1:5440/crm_teste npx vitest run tests/design.test.ts` → PASS (o teste dos dois `abrirOuAnexar` exercita o `23505` de verdade; no `pglite` ele passa por serialização).
- [ ] **Step 3: ponta a ponta** — CRM (`npm run dev`) e ponte (`npm run whatsapp:ponte`, com `AGENTE_PORTA=3031`) com o **número de teste do João** (ele escaneia o QR), Lia em modo `teste` só com o número de teste. Criar um `DESIGNER` e um `COLABORADOR` na tela de Equipe. Do celular de teste, mandar uma mensagem para virar lead; atribuir ao colaborador.
  1. Colaborador: "Enviar para design" sem foto na conversa → job em Na fila, `Sem imagem`, atribuído ao designer, sino do designer tocou.
  2. Designer: Começar → subir mockup v1 → Enviar mockup. **Conferir no celular** que a foto chegou com a legenda (confirmação de envio não é entrega). Conferir que a Lia não respondeu por cima.
  3. Designer: Marcar ajustes → subir v2 → Enviar mockup → Cliente aprovou → no celular chega a v2 com a legenda de confirmação.
  4. Celular responde "ok" → não aprova, sino do designer avisa. Celular responde "APROVO" → `Aprovado`, `ARTE_FINAL` no job, conversa devolvida à Lia.
  5. Designer tenta abrir `/app/crm` e `/api/reports` → redirecionado e 403.
  6. Mudar um lead para `ARTE` no funil → job aberto com origem `PEDIDO`.
- [ ] **Step 4: registrar** o resultado (o que passou, o que falhou, sem telefone) numa seção "Entrega 1" de `docs/dogfooding-modulo-design.md`; falhas viram tarefa de correção antes da entrega 2, num commit `fix` separado.
- [ ] **Step 5: commit** — `git commit -m "docs: validação da entrega 1 do módulo design"`

---

# Entrega 2 — branch `kit-de-partida-por-ia` (a partir de `quadro-de-design`, P1)

Pronta quando: 5 fotos reais geram ficha e paleta; uma falha forçada vai para `NA_FILA` com "IA falhou".

```bash
git switch -c kit-de-partida-por-ia
cd crm && npm i sharp@0.34 zod@3
```

### Task 12: paleta em código

**Files:**
- Create: `crm/src/lib/design/paleta.ts`, `crm/src/lib/design/pantone.json` (P3)
- Test: `crm/tests/paleta.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CorPaleta = { hex: string; pantone_aprox: string | null; participacao: number };
  export async function calcularPaleta(imagem: Buffer): Promise<CorPaleta[]>;
  export function rgbParaLab(r: number, g: number, b: number): [number, number, number];
  export function pantoneMaisProximo(hex: string, tabela?: Array<{ codigo: string; hex: string }>): string | null;
  ```
  Atenção: `crm/src/lib/design.ts` e a pasta `crm/src/lib/design/` convivem; `@/lib/design` resolve para o arquivo. Se o TypeScript reclamar, use `crm/src/lib/designIa/` para a pasta.

- [ ] **Step 1: testes que falham** — `crm/tests/paleta.test.ts`:
```ts
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { calcularPaleta, pantoneMaisProximo, rgbParaLab } from "@/lib/design/paleta";

async function duasCores(): Promise<Buffer> {
  const w = 100, h = 100, px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const azul = i % w < 70; // 70% azul-marinho, 30% amarelo
    px.set(azul ? [0x0a, 0x2a, 0x66] : [0xff, 0xcc, 0x00], i * 3);
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe("paleta", () => {
  it("imagem com 2 cores devolve essas 2, ordenadas por participação", async () => {
    const p = await calcularPaleta(await duasCores());
    expect(p).toHaveLength(2);
    expect(p[0].hex).toBe("#0A2A66");
    expect(p[1].hex).toBe("#FFCC00");
    expect(p[0].participacao).toBeCloseTo(0.7, 1);
  });
  it("é determinística", async () => {
    const img = await duasCores();
    expect(await calcularPaleta(img)).toEqual(await calcularPaleta(img));
  });
  it("Lab do branco e Pantone mais próximo", () => {
    const [L] = rgbParaLab(255, 255, 255);
    expect(L).toBeCloseTo(100, 0);
    expect(pantoneMaisProximo("#00205C", [{ codigo: "281 C", hex: "#00205B" }, { codigo: "Yellow C", hex: "#FEDD00" }])).toBe("281 C");
  });
});
```
  O redimensionamento para 64×64 mistura pixels na fronteira das cores: o k-means pode criar um grupo de transição; ele tem menos de 3% e é descartado. Se o teste mostrar hex ±1 por arredondamento, use `kernel: "nearest"` no `resize`.
- [ ] **Step 2: rodar e ver falhar.**
- [ ] **Step 3: implementar**
```ts
import sharp from "sharp";
import tabelaPadrao from "./pantone.json";

export type CorPaleta = { hex: string; pantone_aprox: string | null; participacao: number };
type RGB = [number, number, number];

const hex = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const deHex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;

export function rgbParaLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function pantoneMaisProximo(h: string, tabela: Array<{ codigo: string; hex: string }> = tabelaPadrao): string | null {
  const alvo = rgbParaLab(...deHex(h));
  let melhor: string | null = null, menor = Infinity;
  for (const p of tabela) {
    const l = rgbParaLab(...deHex(p.hex));
    const d = Math.hypot(alvo[0] - l[0], alvo[1] - l[1], alvo[2] - l[2]); // ΔE CIE76
    if (d < menor) { menor = d; melhor = p.codigo; }
  }
  return melhor;
}

export async function calcularPaleta(imagem: Buffer): Promise<CorPaleta[]> {
  const raw = await sharp(imagem).removeAlpha().resize(64, 64, { fit: "fill", kernel: "nearest" }).raw().toBuffer();
  const px: RGB[] = [];
  for (let i = 0; i < raw.length; i += 3) px.push([raw[i], raw[i + 1], raw[i + 2]]);
  const k = 6;
  let centros: RGB[] = Array.from({ length: k }, (_, i) => px[Math.floor((i * px.length) / k)]); // sementes fixas: resultado determinístico
  let grupo = new Array<number>(px.length).fill(0);
  for (let it = 0; it < 10; it++) {
    grupo = px.map((p) => {
      let m = 0, dm = Infinity;
      centros.forEach((c, j) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < dm) { dm = d; m = j; } });
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
  centros.forEach((c, j) => { const h = hex(c); vistos.set(h, (vistos.get(h) ?? 0) + contagem[j]); }); // sementes iguais viram um grupo só
  return [...vistos.entries()]
    .map(([h, n]) => ({ hex: h, participacao: n / px.length }))
    .filter((c) => c.participacao >= 0.03)
    .sort((a, b) => b.participacao - a.participacao)
    .map((c) => ({ ...c, participacao: Math.round(c.participacao * 100) / 100, pantone_aprox: pantoneMaisProximo(c.hex) }));
}
```
  `pantone.json`: conforme P3 (recomendado: ~40 cores Pantone C comuns, `[{ "codigo": "281 C", "hex": "#00205B" }, ...]`, com uma linha no README do CRM dizendo que é aproximação e de onde veio). Precisa de `"resolveJsonModule": true` no `crm/tsconfig.json` (confira; o Next costuma ligar).
- [ ] **Step 4: rodar** — `npx vitest run tests/paleta.test.ts && npm run typecheck` → PASS.
- [ ] **Step 5: commit** — `git commit -m "feat(crm): paleta por k-means com Pantone aproximado"`

### Task 13: ficha e briefing pelo modelo de visão

**Files:**
- Create: `crm/src/lib/design/ficha.ts`
- Test: `crm/tests/ficha.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const Ficha: z.ZodType<FichaIa>; // esquema da spec seção 8, literal
  export type FichaIa = z.infer<typeof Ficha>;
  export class FalhaIa extends Error { constructor(msg: string, public definitiva: boolean) }
  export const PROMPT_FICHA: string; // texto da spec seção 8, passo 3, literal
  export async function gerarFicha(p: { imagens: Buffer[]; conversa: string; fetchFn?: typeof fetch }): Promise<{ ficha: FichaIa; input_tokens: number; output_tokens: number; modelo: string }>;
  ```

- [ ] **Step 1: testes que falham** — `crm/tests/ficha.test.ts` com `fetchFn` falso:
  1. sucesso: o corpo enviado tem `model`, `response_format.type === "json_schema"`, imagens como `data:image/jpeg;base64,` e a conversa no texto; volta a ficha validada e os tokens de `usage`.
  2. JSON inválido em `choices[0].message.content` → `FalhaIa` com `definitiva: false`.
  3. JSON válido mas fora do esquema (`elementos` com `tipo: "desenho"`) → `FalhaIa` `definitiva: false`.
  4. HTTP 429 e 500 → `definitiva: false`; HTTP 401 → `definitiva: true`.
  5. `OPENAI_API_KEY` vazia → `definitiva: true`, sem chamar o `fetch`.
  6. `fetch` que lança `TimeoutError` → `definitiva: false`.
- [ ] **Step 2: rodar e ver falhar.**
- [ ] **Step 3: implementar** — `sharp(img).rotate().resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 })` em cada imagem (quem chama passa os bytes originais; esta função devolve também `{ largura, altura }` da primeira, via `toBuffer({ resolveWithObject: true })`, para o `imagem_analisada`: inclua `imagem_analisada` no retorno). `POST https://api.openai.com/v1/chat/completions` como em `crm/src/lib/ia/assistant.ts:98` (mesmo cabeçalho), `model: process.env.IA_MODEL || process.env.LLM_MODEL || "gpt-4o-mini"`, `signal: AbortSignal.timeout(60_000)`, mensagens `[{ role: "system", content: PROMPT_FICHA }, { role: "user", content: [{ type: "text", text: `Conversa recente:\n${conversa}` }, ...imagens.map((b) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b.toString("base64")}` } }))] }]`, `response_format: { type: "json_schema", json_schema: { name: "ficha", strict: true, schema: ESQUEMA_JSON } }`. `ESQUEMA_JSON` escrito à mão, espelho do `zod` (strict pede todos os campos em `required` e `additionalProperties: false`; nulos como `type: ["string", "null"]`; `bbox` como `type: ["array", "null"], items: { type: "number" }`; o tamanho 4 é conferido pelo `zod`).
- [ ] **Step 4: rodar** → PASS. **Step 5: commit** — `git commit -m "feat(crm): ficha técnica e briefing pelo modelo de visão"`

### Task 14: worker

**Files:**
- Create: `crm/scripts/designWorker.ts`, `crm/src/lib/design/worker.ts`
- Modify: `crm/package.json` (`"design:worker": "tsx --env-file-if-exists=.env scripts/designWorker.ts"`)
- Test: `crm/tests/worker.test.ts`

**Interfaces:**
- Consumes: `gerarFicha`, `FalhaIa` (Task 13); `calcularPaleta` (Task 12); `mudarEtapaTx`, `registrarEvento` (Task 4); `armazem().ler`.
- Produces:
  ```ts
  export async function pegarProximo(): Promise<{ id: string; lead_id: string; tentativa: number } | null>; // FOR UPDATE SKIP LOCKED, incrementa ia_tentativas e devolve o valor novo
  export async function processarJob(job: { id: string; lead_id: string; tentativa: number }, deps?: { fetchFn?: typeof fetch }): Promise<"ok" | "nova_tentativa" | "falhou" | "descartado">;
  export async function rodarUmaVez(deps?): Promise<boolean>; // false = fila vazia
  ```

- [ ] **Step 1: testes que falham** — `crm/tests/worker.test.ts` (imagem real gerada com `sharp` como na Task 12; `fetchFn` falso):
  1. sucesso: `ficha` com os campos do modelo + `paleta` + `imagem_analisada`, `briefing` gravado, `ia_status = 'OK'`, evento `ia_ok` com `input_tokens`, `output_tokens` e `modelo`, etapa `NA_FILA`, designer atribuído.
  2. 3 falhas seguidas (500): depois da 1ª, `ia_proxima_tentativa_em` ≈ agora + 30 s e o job continua em `PROCESSANDO_IA`; `pegarProximo` não o pega antes da hora (adiante o relógio com `UPDATE ... SET ia_proxima_tentativa_em = NOW() - interval '1 s'`); depois da 2ª, + 120 s; na 3ª, `FALHOU`, evento `ia_falhou` com motivo curto, `NA_FILA`.
  3. JSON inválido conta como falha (`nova_tentativa`).
  4. 401: `FALHOU` na 1ª.
  5. Imagem nova chega durante o processamento (Review Focus 2): entre `pegarProximo` e o fim, chame `abrirOuAnexar` com outra imagem (o falso do `fetch` faz isso antes de responder); `processarJob` devolve `descartado`, o job segue em `PROCESSANDO_IA` com `ia_tentativas = 0`.
  6. Job cancelado durante o processamento (Review Focus 3): mesmo esquema com `mudarEtapa(..., "CANCELADO")`; `descartado`, o job segue `CANCELADO`, sem ficha.
  7. Job só com PDF (não deveria estar em `PROCESSANDO_IA`, mas um reprocessamento manual pode pôr): `SEM_IMAGEM` e `NA_FILA`, sem chamar o `fetch`.
- [ ] **Step 2: rodar e ver falhar.**
- [ ] **Step 3: implementar `worker.ts`**
  - `pegarProximo`: numa transação, o `SELECT` da spec seção 8 com `FOR UPDATE SKIP LOCKED`, depois `UPDATE design_jobs SET ia_tentativas = ia_tentativas + 1 WHERE id = $1 RETURNING ia_tentativas`.
  - `processarJob`: lê até 4 `ORIGINAL` analisáveis (por `mime` em `image/png|jpeg|webp`, `ORDER BY created_at DESC`); nenhum → `SEM_IMAGEM` + `NA_FILA` (com a guarda abaixo). Conversa: `SELECT author, body FROM messages WHERE lead_id = $1 AND kind = 'texto' ORDER BY sent_at DESC LIMIT 20`, invertida, `CLIENTE:`/`LOJA:` por linha. `gerarFicha` + `calcularPaleta(primeira)`.
  - Gravação do sucesso numa transação com a guarda: `UPDATE design_jobs SET ficha = $2, briefing = $3, ia_status = 'OK' WHERE id = $1 AND stage = 'PROCESSANDO_IA' AND ia_tentativas = $4 RETURNING id`; sem linha → `descartado` (rollback); com linha → evento `ia_ok` e `mudarEtapaTx(tx, id, "NA_FILA", null)`.
  - Falha: `FalhaIa.definitiva` ou `tentativa >= 3` → mesma guarda, `ia_status = 'FALHOU'`, evento `ia_falhou` com `{ motivo: err.message.slice(0, 120), modelo }`, `NA_FILA`. Senão `ia_proxima_tentativa_em = NOW() + make_interval(secs => $2)` com 30 (tentativa 1) ou 120 (tentativa 2), com a guarda. Erro que não é `FalhaIa` (imagem corrompida no `sharp`, banco) conta como falha não definitiva.
  - Uma linha de log por job: `console.log(JSON.stringify({ job, etapa, ms, tokens, erro }))`, sem conteúdo da conversa nem da ficha. 401/sem chave: `console.error` com destaque.
- [ ] **Step 4: `scripts/designWorker.ts`** — laço: `while (!parar) { const teve = await rodarUmaVez().catch((e) => (console.error("worker:", e), false)); if (!teve) await esperar(5_000); }`, com `SIGINT`/`SIGTERM` ligando `parar` e a espera interrompível; nunca sai por erro de um job.
- [ ] **Step 5: rodar** — `npx vitest run && npm run typecheck` → PASS. **Step 6: commit** — `git commit -m "feat(crm): worker do kit de partida com novas tentativas"`

### Task 15: ficha, paleta e bboxes na tela

**Files:**
- Modify: `crm/src/components/design/DesignJobView.tsx`

- [ ] **Step 1:** esquerda: sobre o primeiro original, um `<svg>` absoluto com `viewBox={`0 0 ${largura} ${altura}`}` de `ficha.imagem_analisada` e um `<rect>` por elemento com `bbox` (proporção correta em qualquer tamanho de tela, sem conta à mão); a ficha (peça, gola, manga, tecido provável, observações) e o briefing.
- [ ] **Step 2:** centro: lista de elementos (tipo, conteúdo, posição) e a paleta (amostra, HEX, "~Pantone 281 C", participação em %), com o aviso "Pantone aproximado". Selo do job: `IA ok`, `IA falhou` (com "Reprocessar IA"), `Sem imagem`, `Analisando...`.
- [ ] **Step 3:** `cd crm && npm run typecheck && npm run build` → PASS. **Step 4: commit** — `git commit -m "feat(crm): ficha, paleta e marcações da IA no detalhe do job"`

### Task 16: validação da entrega 2

- [ ] **Step 1:** ambiente da Task 11 + `npm run design:worker` em outro terminal (`OPENAI_API_KEY` do `crm/.env`).
- [ ] **Step 2:** 5 fotos reais de uniforme **que o João fornecer, sem dado de cliente** (rosto, telefone, nome de escola identificável: perguntar antes), uma por job, pelo upload manual do `LeadPanel`. Para cada: ficha coerente com a foto (o designer ou o João julga), paleta com as cores visíveis, bboxes no lugar, tempo e tokens do evento `ia_ok`.
- [ ] **Step 3:** falha forçada: worker com `OPENAI_API_KEY=sk-invalida` → `IA falhou` na hora (401); e com a rede bloqueada para a OpenAI (ex.: `HTTPS_PROXY=http://127.0.0.1:9`) → 3 tentativas espaçadas e `IA falhou` em `NA_FILA`.
- [ ] **Step 4:** custo: some os tokens dos 5 `ia_ok` e estime por job (pelos tokens gravados, nunca no chute).
- [ ] **Step 5:** registrar em `docs/dogfooding-modulo-design.md`, seção "Entrega 2", e commitar.

---

# Entrega 3 — branch `lia-encaminha-ao-design` (a partir de `kit-de-partida-por-ia`, P1)

Pronta quando: A/B sem queda nos evals afetados; dogfooding da spec seção 11 aprovado.

### Task 17: ferramenta `encaminhar_design`

**Files:**
- Create: `src/tools/encaminharDesign.ts`
- Modify: `src/tools/index.ts` (registro, depois de `registrar_arte`)
- Test: `tests/encaminharDesign.test.ts`

**Interfaces:**
- Consumes: `encaminharParaDesign`, `setEncaminharParaDesign` (Task 7).
- Produces: `encaminharDesignSchema` (spec 9.3, literal), `encaminharDesignHandler(input, state, client)`, `MENSAGEM_ENCAMINHADO = "Recebi! Vou passar para nossa equipe de design, que vai te chamar por aqui."`.

- [ ] **Step 1: testes que falham**: sucesso (o falso recebe `origem: "LIA"`, `telefone` do estado, `motivo`, `observacao` e todos os `arquivosRecebidos`; resposta `{ status: "encaminhado", mensagem: MENSAGEM_ENCAMINHADO }`); CRM fora (falso lança) → `{ status: "erro", mensagem, instrucao }` com a instrução de chamar `transferir_humano`, e `state.arquivosRecebidos` intacto; chamada repetida no mesmo turno → o falso é chamado de novo (o CRM é quem anexa ao job aberto) e a resposta é a mesma; canal que não é WhatsApp (`state.canal !== "whatsapp"`) sem arquivos ainda encaminha (o vendedor pode subir à mão).
- [ ] **Step 2: rodar e ver falhar.**
- [ ] **Step 3: implementar** no molde de `registrarArte.ts`; registrar em `index.ts` com a `description` "Encaminha à equipe de design: referência de uniforme ou peça para reproduzir, criação de arte ou ajuste numa arte enviada. Logo pronta só para gravar não: use registrar_arte." (a descrição é parte do que o modelo lê: entra no A/B da Task 19).
- [ ] **Step 4: rodar** — `npx vitest run && npm run typecheck` → PASS. **Step 5: commit** — `git commit -m "feat(agente): ferramenta encaminhar_design da Lia"`

### Task 18: `transferirHumano` encaminha ajustes ao design

**Files:**
- Modify: `src/tools/transferirHumano.ts`
- Test: `tests/transferirHumanoDesign.test.ts`

- [ ] **Step 1: testes que falham**: motivo `ajuste_mockup` → depois da transferência normal, o falso de `setEncaminharParaDesign` recebe `origem: "LIA"` e `observacao` com o motivo e a observação; motivo `arte_problematica` idem; motivo `desconto` não chama; falso que lança → a transferência devolve o mesmo resultado de sempre e o erro vai para o log (`console.warn` ou o logger do repo).
- [ ] **Step 2: rodar e ver falhar. Step 3: implementar** (chamada com `await` depois de montar o resumo, dentro de `try/catch`; o timeout de 30 s da Task 7 limita a espera). **Step 4: rodar** → PASS. **Step 5: commit** — `git commit -m "feat(agente): transferência de ajuste de arte abre job de design"`

### Task 19: prompt, evals 42–44 e A/B

**Files:**
- Create: `evals/scenarios/42_referencia_uniforme_vai_ao_design.json`, `43_logo_pronta_nao_vai_ao_design.json`, `44_ajuste_de_mockup_vai_ao_design.json`
- Modify: `evals/ambiente.ts` (falso de `setEncaminharParaDesign` que devolve `{ jobId: "job-eval", imagens: n }`), o arquivo do prompt da Lia (seção de arte; ache com `grep -rn "registrar_arte" src/agent`)

- [ ] **Step 1: evals novos**, no formato de `evals/scenarios/15_arte_exe.json`. A mensagem de mídia segue o formato que a ponte gera (confira em `src/whatsapp/midia.ts` e nos cenários com arquivo); sem telefone nem nome real:
  - 42: `"[arquivo recebido: uniforme-referencia.jpg]"` + "quero uma camisa igual a essa com a logo da minha escola" → `chamou_ferramenta encaminhar_design`, `nao_chamou_ferramenta registrar_arte`.
  - 43: `"[arquivo recebido: logo.png]"` + "quero essa logo gravada em 50 canecas" → `chamou_ferramenta registrar_arte`, `nao_chamou_ferramenta encaminhar_design`.
  - 44: histórico com mockup enviado + "pode trocar o azul da arte por vermelho?" → `chamou_ferramenta encaminhar_design` ou `transferir_humano` com `ajuste_mockup` (o que o tipo de expectativa permitir; confira `evals/runEvals.ts`).
- [ ] **Step 2: linha de base (antes do prompt)** — 3 rodadas dos afetados: `npm run evals -- 10_pede_atendente 11_api_500 15_arte_exe 22_reclamacao 25_insiste_humano 32_pix_nunca_sai 42 43 44` (confira a sintaxe de filtro em `evals/runEvals.ts`). Anote por cenário: passou x/3. Custo: centavos.
- [ ] **Step 3: PARE e peça o OK do João** para o texto da spec 9.5, mostrando a linha de base. Sem OK, a entrega para aqui.
- [ ] **Step 4:** com o OK, acrescente o texto da spec 9.5, literal, na seção de arte do prompt. Rode as mesmas 3 rodadas.
- [ ] **Step 5:** critério: nenhum cenário existente cai (x/3 depois ≥ x/3 antes); 42–44 em 3/3. Queda → mostrar ao João, com a diferença, antes de qualquer ajuste de texto (mudança de texto também é com OK).
- [ ] **Step 6: commit** — `git commit -m "feat(agente): Lia encaminha referências e ajustes ao design"` (com a tabela antes/depois na mensagem).

### Task 20: dogfooding de ponta a ponta

- [ ] **Step 1:** ambiente das Tasks 11 e 16, Lia em modo `teste`, `ORCAMENTO_ESCRITA=simulada`, número de teste do João.
- [ ] **Step 2:** 5 fotos reais de uniforme (as mesmas da Task 16) pela história da spec seção 1, do WhatsApp de teste: a Lia encaminha, o worker monta o kit, o designer manda o mockup, a Lia fica quieta, "ok" não aprova, "APROVO" aprova, a conversa volta à Lia. Uma das 5 com uma logo pronta para caneca: não pode abrir job.
- [ ] **Step 3:** registrar em `docs/dogfooding-modulo-design.md`, seção "Entrega 3" (sem telefone), e commitar com `docs:`.
- [ ] **Step 4:** atualizar a nota do projeto no cofre e o Kanban (fase concluída), e a memória `presentes-especiais-agente.md` ("Agora").

---

## Fora deste plano

- Benchmark da entrega 3 da task (spec seção 12, `docs/benchmark-vetorizacao.md`): é documento com serviços pagos de terceiros (SAM 2, Vectorizer.AI); fica para depois das 3 entregas, com o OK do João.
- Ensaio do R2: espera a conta do Dudu (spec 13.1).
- Push, PR e a junção dos commits por branch: só com a ordem do João.
