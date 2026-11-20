# Banco no Neon: plano de implementação

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para executar tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** tirar de `data/` todo o estado do agente e pô-lo num Postgres (Docker em dev, Neon fora dele), no schema `agente`, com usuário próprio.

**Arquitetura:** a camada `src/db/banco.ts` abre o banco (`pg` em dev e produção, pglite só nos testes) e aplica as migrations de `db/migrations/`. Cada store ganha uma versão `Pg*` e mantém a `Memory*` para os testes. As versões em arquivo saem. As interfaces viram assíncronas. As entradas (`src/api/index.ts`, `src/whatsapp/index.ts`, `src/cli.ts` e os scripts) abrem o banco uma vez e ligam os stores com `ligarStores(banco)`.

**Tech stack:** Node 20, TypeScript (`tsx`, ESM, `moduleResolution: Bundler`), vitest 2, `pg` 8.16.3, `@electric-sql/pglite` 0.3.14 (testes), Docker `pgvector/pgvector:pg17`.

**Spec:** `docs/superpowers/specs/2026-11-10-banco-neon-design.md`. Leia antes de começar.

## Restrições globais

- Branch `banco-neon`. Commits locais; **nada de push** sem o OK do João.
- Todas as tabelas no schema `agente`, sempre com o nome qualificado (`agente.conversas`), sem depender de `search_path`.
- Migrations só com `IF NOT EXISTS`. Nunca editar uma migration já commitada: crie a próxima.
- `AGENTE_DATABASE_URL` só no `.env`. Fora de `localhost`/`127.0.0.1` exige `sslmode=require`.
- Erro de banco no log só com `code` e `message`. Nunca a URL, os parâmetros da consulta ou o texto da conversa.
- Nunca rodar nada contra o Neon do Dudu. Dev é o Docker na porta **5440**; a 5439 é do demo do DC Lab.
- Nunca rodar `npm run sync:pedidos` (grava dados pessoais reais).
- Não mexer em nada dentro de `crm/` (é do Dudu).
- Testes com 1 worker quando a máquina apertar: `npx vitest run --pool=forks --poolOptions.forks.singleFork`.
- Comentário no código só para o porquê que o código não mostra, numa linha.
- O que encosta na busca (`ProductIndexStore` ligado nos chamadores, `TipoStore`, `VectorStore`) **só depois** que a `busca-semantica` do Gui voltar (Tarefas 9 a 12).

## Diferenças em relação à spec (decididas no plano; o João revisa)

1. **Sem `agente.orcamentos_teste`.** A escrita simulada foi removida em 25/10 (`src/config.ts:52`); o arquivo é só resto antigo. Sai a chave `orcamentosTesteArquivo` e o ramo da retenção; o arquivo é apagado na Tarefa 12.
2. **Sem `agente.preco_grupos`.** As faixas de venda já vivem dentro de cada `ProdutoIndexado` (`subprodutos[].faixas`); `agente.produtos` guarda o produto inteiro em JSONB.
3. **`agente.modo_lia` é tabela própria** (uma linha), em vez de um campo em `estado_ponte`: os dois são gravados em momentos diferentes, e cada um tem um dono.
4. **Entra `agente.estado_sistema`**, que a spec não listava: é o interruptor de suspensão (`data/estado-sistema.json`), gravado pela ponte e lido pela API.
5. **Sync do catálogo:** o `sincronizarCatalogo` já é incremental (só relê o detalhe quando o `updated_at` muda ou o registro passou de `maxIdadeHoras`) e já roda dentro da API a cada 6 h (`src/api/index.ts:13`). O "a cada 30–60 min" vira o intervalo desse timer (`CATALOGO_INTERVALO_MIN`, padrão 45), sem tarefa no Agendador do Windows. No Agendador fica só o `sync:precos` noturno. Como a busca lê o mesmo store, isso vai junto com a ligação do catálogo (Tarefa 9).
6. **O `sync:agente` do CRM** (`crm/scripts/syncAgente.ts`) lê as conversas em arquivo e deixa de achar dados. Não mexemos no CRM: isso entra no pedido ao Dudu (Tarefa 8). A ponte já manda as mensagens ao vivo para o CRM.

## Foco da revisão

Condições que a spec implica e que quebram se ninguém testar (cada uma tem teste na tarefa dona):

1. **Gravações fora de ordem da mesma conversa.** O `aoEfeito` do `runTurn` grava no meio do turno sem esperar; uma gravação antiga não pode chegar depois da nova. → Tarefa 2, teste "gravações seguidas chegam em ordem".
2. **Conversa mudada depois do `salvar`.** O objeto em memória continua mudando; o que vai ao banco é o retrato do momento do `salvar`. → Tarefa 2, teste "salvar grava o retrato da hora".
3. **Banco fora do ar com o sistema suspenso.** Se a releitura falhar, a API não pode "dessuspender" sozinha. → Tarefa 4, teste "falha de leitura mantém o último estado".
4. **Telefone malformado chegando ao banco.** Hoje o nome do arquivo barra; no banco quem barra é o `RepositorioConversas` (e o `CHECK` da tabela). → Tarefa 2, teste "telefone inválido é recusado".
5. **Saída da ponte com gravação pendente.** O `SIGINT` precisa esperar a última gravação do estado. → Tarefa 3, teste "salvarAgora devolve a gravação".

---

## Mapa de arquivos

| Arquivo | Tarefa | Responsabilidade |
|---|---|---|
| `package.json`, `.env.example`, `docker-compose.yml` | 1 | dependências, URL, Postgres de dev |
| `db/migrations/001_inicial.sql` | 1 | schema e tabelas sem busca |
| `db/dev-init.sql`, `db/papel-agente.sql` | 1 | papéis no Docker e no Neon |
| `src/db/banco.ts` | 1 | `Banco`, `abrirBanco`, `aplicarMigrations`, `logarErroBanco` |
| `scripts/dbMigrate.ts` | 1 | `npm run db:migrate` |
| `tests/helpers/bancoDeTeste.ts` | 1 | pglite em memória com migrations |
| `src/conversas/armazem.ts` | 2 | `ArmazemConversas`, `MemoriaConversas`, `PgConversas` |
| `src/conversas/repositorio.ts` | 2 | validação, cortes e fila de gravação (assíncrono) |
| `src/api/agenteDefinitivo.ts` | 2 | `await` no repositório |
| `src/whatsapp/crm.ts` | 2 | lê a conversa pelo armazém, não pelo disco |
| `src/whatsapp/estadoPonte.ts`, `src/whatsapp/modoLia.ts`, `src/whatsapp/ponte.ts`, `src/whatsapp/controle.ts` | 3 | estado da ponte e modo da Lia no banco |
| `src/controle/estadoSistema.ts`, `src/whatsapp/atendente.ts` | 4 | interruptor no banco |
| `src/knowledge/lacunas.ts`, `src/integrations/brindeme/orderIndex.ts`, `src/tools/*` | 5 | lacunas e pedidos no banco |
| `src/db/stores.ts` | 5 | `ligarStores(banco)` |
| `src/operacao/retencao.ts`, `src/operacao/retencaoBanco.ts`, `scripts/limparDados.ts` | 6 | retenção |
| `db/migrations/002_catalogo.sql`, `src/catalogo/indicePg.ts` | 7 | catálogo no banco (não ligado) |
| `scripts/fumacaBanco.ts`, `docs/pedido-ao-dudu-banco.md` | 8 | fumaça e pedido ao Dudu |

---

### Tarefa 1: camada de banco, migrations e Postgres de dev

**Arquivos:**
- Criar: `src/db/banco.ts`, `db/migrations/001_inicial.sql`, `db/dev-init.sql`, `db/papel-agente.sql`, `docker-compose.yml`, `scripts/dbMigrate.ts`, `tests/helpers/bancoDeTeste.ts`, `tests/banco.test.ts`
- Modificar: `package.json`, `.env.example`

**Interfaces:**
- Produz:
  - `interface Executor { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> }`
  - `interface Banco extends Executor { executar(sql: string): Promise<void>; transacao<T>(fn: (tx: Executor) => Promise<T>): Promise<T>; fechar(): Promise<void> }`
  - `abrirBanco(url?: string): Promise<Banco>` (aplica as migrations ao abrir)
  - `exigirSsl(url: string): void`
  - `aplicarMigrations(banco: Banco): Promise<string[]>`
  - `logarErroBanco(err: unknown): Record<string, unknown>`, que devolve `{ code, message }`
  - `bancoDeTeste(): Promise<Banco>` (tests/helpers)

- [ ] **Passo 1: dependências**

```bash
npm install pg@8.16.3
npm install -D @types/pg @electric-sql/pglite@0.3.14
```

No `package.json`, em `scripts`, acrescente:

```json
"db:migrate": "tsx scripts/dbMigrate.ts",
"db:subir": "docker compose up -d banco",
```

- [ ] **Passo 2: o teste que falha** (`tests/banco.test.ts`)

```ts
import { describe, it, expect, afterEach } from "vitest";
import { exigirSsl, aplicarMigrations, logarErroBanco, type Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";

describe("banco", () => {
  let banco: Banco | undefined;
  afterEach(async () => {
    await banco?.fechar();
    banco = undefined;
  });

  it("aplica as migrations uma vez só", async () => {
    banco = await bancoDeTeste();
    expect(await aplicarMigrations(banco)).toEqual([]);
    const tabelas = await banco.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'agente' ORDER BY 1"
    );
    expect(tabelas.map((t) => t.table_name)).toEqual(
      expect.arrayContaining(["conversas", "conversas_corrompidas", "estado_ponte", "modo_lia", "estado_sistema", "lacunas", "pedidos", "schema_migrations"])
    );
  });

  it("transação desfaz tudo se der erro", async () => {
    banco = await bancoDeTeste();
    await expect(
      banco.transacao(async (tx) => {
        await tx.query("INSERT INTO agente.lacunas (conversa_id, pergunta, registrado_em) VALUES ('c', 'p', now())");
        throw new Error("falhou");
      })
    ).rejects.toThrow("falhou");
    expect(await banco.query("SELECT 1 FROM agente.lacunas")).toEqual([]);
  });

  it("recusa banco remoto sem sslmode=require", () => {
    expect(() => exigirSsl("postgres://u:s@ep-x.sa-east-1.aws.neon.tech/db")).toThrow(/sslmode=require/);
    expect(() => exigirSsl("postgres://u:s@ep-x.sa-east-1.aws.neon.tech/db?sslmode=require")).not.toThrow();
    expect(() => exigirSsl("postgres://agente:agente@localhost:5440/agente")).not.toThrow();
  });

  it("o log de erro não leva a URL nem os parâmetros", () => {
    const err = Object.assign(new Error("duplicate key"), { code: "23505", parameters: ["5583999990000"] });
    expect(logarErroBanco(err)).toEqual({ code: "23505", message: "duplicate key" });
  });
});
```

- [ ] **Passo 3: rodar e ver falhar**

Run: `npx vitest run tests/banco.test.ts`
Expected: FAIL (`Cannot find module '../src/db/banco.js'`)

- [ ] **Passo 4: `db/migrations/001_inicial.sql`**

```sql
CREATE SCHEMA IF NOT EXISTS agente;

CREATE TABLE IF NOT EXISTS agente.conversas (
  telefone TEXT PRIMARY KEY CHECK (telefone ~ '^[0-9]{10,15}$'),
  doc JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversas_atualizado_em ON agente.conversas (atualizado_em);

CREATE TABLE IF NOT EXISTS agente.conversas_corrompidas (
  id BIGSERIAL PRIMARY KEY,
  telefone TEXT NOT NULL,
  doc JSONB,
  erro TEXT NOT NULL,
  separado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agente.estado_ponte (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  doc JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agente.modo_lia (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  config JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agente.estado_sistema (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  estado JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agente.lacunas (
  id BIGSERIAL PRIMARY KEY,
  conversa_id TEXT NOT NULL,
  pergunta TEXT NOT NULL,
  categoria_sugerida TEXT,
  registrado_em TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS lacunas_registrado_em ON agente.lacunas (registrado_em);
CREATE INDEX IF NOT EXISTS lacunas_conversa ON agente.lacunas (conversa_id);

CREATE TABLE IF NOT EXISTS agente.pedidos (
  id TEXT PRIMARY KEY,
  codigo TEXT NOT NULL,
  telefone TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  criado_em TEXT NOT NULL,
  sincronizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pedidos_codigo ON agente.pedidos (codigo);
```

(`criado_em`/`sincronizado_em` de pedidos ficam `TEXT` porque o `PedidoIndexado` já guarda a string ISO da API e o código compara strings; assim, ida e volta não mudam o valor.)

- [ ] **Passo 5: `src/db/banco.ts`**

```ts
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export type Linha = Record<string, unknown>;

export interface Executor {
  query<T = Linha>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Banco extends Executor {
  /** Vários comandos de uma vez, sem parâmetros (arquivos de migration). */
  executar(sql: string): Promise<void>;
  transacao<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  fechar(): Promise<void>;
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
const LOCAIS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function exigirSsl(url: string): void {
  const u = new URL(url);
  const ssl = u.searchParams.get("sslmode");
  if (!LOCAIS.has(u.hostname) && ssl !== "require" && ssl !== "verify-full") {
    throw new Error("AGENTE_DATABASE_URL fora do localhost precisa de sslmode=require.");
  }
}

export function logarErroBanco(err: unknown): Record<string, unknown> {
  const e = err as { code?: unknown; message?: unknown };
  return { code: typeof e?.code === "string" ? e.code : undefined, message: typeof e?.message === "string" ? e.message : String(err) };
}

export async function aplicarMigrations(banco: Banco): Promise<string[]> {
  await banco.executar(
    "CREATE SCHEMA IF NOT EXISTS agente; CREATE TABLE IF NOT EXISTS agente.schema_migrations (nome TEXT PRIMARY KEY, aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now())"
  );
  const feitas = new Set((await banco.query<{ nome: string }>("SELECT nome FROM agente.schema_migrations")).map((r) => r.nome));
  const aplicadas: string[] = [];
  for (const arquivo of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (feitas.has(arquivo)) continue;
    const sql = readFileSync(join(MIGRATIONS, arquivo), "utf8");
    await banco.transacao(async (tx) => {
      await tx.query(sql);
      await tx.query("INSERT INTO agente.schema_migrations (nome) VALUES ($1)", [arquivo]);
    });
    aplicadas.push(arquivo);
  }
  return aplicadas;
}

export async function abrirBanco(url = process.env.AGENTE_DATABASE_URL): Promise<Banco> {
  if (!url) throw new Error("AGENTE_DATABASE_URL não configurada (veja .env.example e npm run db:subir).");
  exigirSsl(url);
  const { default: pg } = await import("pg");
  pg.types.setTypeParser(1700, (v: string) => Number(v));
  pg.types.setTypeParser(20, (v: string) => Number(v));
  const pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 });
  pool.on("error", (err) => console.error(JSON.stringify({ type: "banco_erro", ...logarErroBanco(err) })));
  const banco: Banco = {
    query: async <T,>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[],
    executar: async (sql) => {
      await pool.query(sql);
    },
    async transacao(fn) {
      const cliente = await pool.connect();
      try {
        await cliente.query("BEGIN");
        const r = await fn({ query: async <T,>(s: string, p: unknown[] = []) => (await cliente.query(s, p)).rows as T[] });
        await cliente.query("COMMIT");
        return r;
      } catch (err) {
        await cliente.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        cliente.release();
      }
    },
    fechar: () => pool.end(),
  };
  await aplicarMigrations(banco);
  return banco;
}
```

Atenção: dentro da transação da migration, `tx.query(sql)` recebe o arquivo inteiro. No `pg`, uma consulta **sem parâmetros** aceita vários comandos. No pglite, o helper de teste implementa `query` sem parâmetros com `exec` (Passo 6).

- [ ] **Passo 6: `tests/helpers/bancoDeTeste.ts`**

```ts
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { aplicarMigrations, type Banco, type Executor } from "../../src/db/banco.js";

function executor(db: Pick<PGlite, "query" | "exec">): Executor {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      // Sem parâmetros pode haver vários comandos (migrations): o exec aceita, o query não.
      if (params.length === 0 && sql.includes(";")) {
        const r = await db.exec(sql);
        return (r.at(-1)?.rows ?? []) as T[];
      }
      return (await db.query<T>(sql, params)).rows;
    },
  };
}

/** Postgres em memória, com pgvector e as migrations aplicadas. Um por teste. */
export async function bancoDeTeste(): Promise<Banco> {
  const db = await PGlite.create({
    extensions: { vector },
    parsers: { 1700: (v: string) => Number(v), 20: (v: string) => Number(v) },
  });
  await db.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const base = executor(db);
  const banco: Banco = {
    query: base.query,
    executar: async (sql) => {
      await db.exec(sql);
    },
    transacao: (fn) => db.transaction((tx) => fn(executor(tx as unknown as PGlite))),
    fechar: () => db.close(),
  };
  await aplicarMigrations(banco);
  return banco;
}
```

- [ ] **Passo 7: rodar e ver passar**

Run: `npx vitest run tests/banco.test.ts`
Expected: PASS (4 testes)

- [ ] **Passo 8: Docker, papéis e `.env.example`**

`docker-compose.yml`:

```yaml
services:
  banco:
    image: pgvector/pgvector:pg17
    container_name: agente-banco
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: agente
    ports:
      - "5440:5432"
    mem_limit: 256m
    volumes:
      - agente-banco:/var/lib/postgresql/data
      - ./db/dev-init.sql:/docker-entrypoint-initdb.d/01-dev-init.sql:ro
volumes:
  agente-banco:
```

`db/dev-init.sql` (só o Docker roda; senhas de dev, nunca usadas fora dele):

```sql
-- Mesmos papéis do Neon (db/papel-agente.sql), com senha de dev, mais um "crm" para conferir o isolamento.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE agente LOGIN PASSWORD 'agente';
CREATE ROLE crm LOGIN PASSWORD 'crm';
CREATE SCHEMA agente AUTHORIZATION agente;
REVOKE ALL ON SCHEMA agente FROM PUBLIC;
CREATE TABLE public.crm_teste (id INT);
ALTER TABLE public.crm_teste OWNER TO crm;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM agente;
```

`db/papel-agente.sql` (o Dudu roda uma vez no SQL Editor do Neon; nós nunca rodamos):

```sql
-- Rode uma vez, como dono do banco, no SQL Editor do Neon. Troque a senha antes.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE agente LOGIN PASSWORD 'TROQUE_ESTA_SENHA';
CREATE SCHEMA IF NOT EXISTS agente AUTHORIZATION agente;
-- Ninguém além do agente usa o schema dele.
REVOKE ALL ON SCHEMA agente FROM PUBLIC;
-- O agente não lê as tabelas do CRM.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM agente;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM agente;
```

No `.env.example`, acrescente:

```
# Banco do agente (schema agente). Dev: npm run db:subir. Neon: usuário agente, com sslmode=require.
AGENTE_DATABASE_URL=postgres://agente:agente@localhost:5440/agente
```

E no seu `.env` local, a mesma linha.

- [ ] **Passo 9: `scripts/dbMigrate.ts`**

```ts
import "dotenv/config";
import { abrirBanco, aplicarMigrations } from "../src/db/banco.js";

const banco = await abrirBanco();
try {
  const aplicadas = await aplicarMigrations(banco);
  console.log(aplicadas.length ? `Aplicadas: ${aplicadas.join(", ")}` : "Banco já está atualizado.");
} finally {
  await banco.fechar();
}
```

(`abrirBanco` já aplica; o script existe para rodar a migration sem subir o agente, e a segunda chamada imprime o "já está atualizado".)

- [ ] **Passo 10: conferir contra o Docker**

```bash
npm run db:subir
npm run db:migrate
```

Expected: `Aplicadas: 001_inicial.sql` na primeira vez.

Isolamento (critério 5 da spec), com o `psql` de dentro do container:

```bash
docker exec agente-banco psql -U crm -d agente -c "SELECT * FROM agente.conversas"
docker exec agente-banco psql -U agente -d agente -c "SELECT * FROM public.crm_teste"
```

Expected: os dois falham com `permission denied`.

- [ ] **Passo 11: typecheck, testes e commit**

Run: `npm run typecheck` e `npx vitest run`
Expected: typecheck limpo; todos os testes passam.

```bash
git add package.json package-lock.json .env.example docker-compose.yml db src/db scripts/dbMigrate.ts tests/helpers/bancoDeTeste.ts tests/banco.test.ts
git commit -m "feat(banco): camada de banco do agente com migrations e Postgres de dev"
```

---

### Tarefa 2: conversas no banco

**Arquivos:**
- Criar: `src/conversas/armazem.ts`, `tests/armazemConversas.test.ts`
- Modificar: `src/conversas/repositorio.ts`, `src/api/agenteDefinitivo.ts:75,104,110-120,168,213,270`, `src/whatsapp/crm.ts:28-32,86-92`, `src/whatsapp/index.ts:35`, `src/api/index.ts:60`, `tests/repositorioConversas.test.ts`, e os testes que constroem `new RepositorioConversas(dir)` (ache com `grep -rln "RepositorioConversas" tests evals`)

**Interfaces:**
- Consome: `Executor`, `bancoDeTeste` (Tarefa 1)
- Produz:
  - `interface ArmazemConversas { ler(telefone: string): Promise<unknown | null>; gravar(telefone: string, doc: unknown): Promise<void>; separarCorrompido(telefone: string, doc: unknown, erro: string): Promise<void> }`
  - `class MemoriaConversas implements ArmazemConversas` (com `corrompidos: Array<{ telefone: string; erro: string }>` público, para testes)
  - `class PgConversas implements ArmazemConversas` (`constructor(banco: Banco)`)
  - `RepositorioConversas`: `constructor(armazem: ArmazemConversas, log?)`, `existe(t): Promise<boolean>`, `carregar(t): Promise<Conversa>`, `salvar(c): Promise<void>`

- [ ] **Passo 1: o teste de contrato que falha** (`tests/armazemConversas.test.ts`)

```ts
import { describe, it, expect, afterEach } from "vitest";
import { MemoriaConversas, PgConversas, type ArmazemConversas } from "../src/conversas/armazem.js";
import { RepositorioConversas, MAX_IDS_VISTOS } from "../src/conversas/repositorio.js";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";

const TEL = "5583999990000";
let banco: Banco | undefined;
afterEach(async () => {
  await banco?.fechar();
  banco = undefined;
});

const versoes: Array<[string, () => Promise<ArmazemConversas>]> = [
  ["memória", async () => new MemoriaConversas()],
  ["postgres", async () => new PgConversas((banco = await bancoDeTeste()))],
];

describe.each(versoes)("RepositorioConversas sobre %s", (_nome, criar) => {
  it("telefone sem registro → conversa nova e existe() falso", async () => {
    const repo = new RepositorioConversas(await criar());
    expect(await repo.existe(TEL)).toBe(false);
    const c = await repo.carregar(TEL);
    expect(c.estado.telefone).toBe(TEL);
    expect(c.estado.modo).toBe("ia");
  });

  it("salva e relê num repositório novo (reinício)", async () => {
    const armazem = await criar();
    const repo = new RepositorioConversas(armazem);
    const c = await repo.carregar(TEL);
    c.estado.modo = "humano";
    c.idsVistos.push("m1");
    await repo.salvar(c);
    const relida = await new RepositorioConversas(armazem).carregar(TEL);
    expect(relida.estado.modo).toBe("humano");
    expect(relida.idsVistos).toEqual(["m1"]);
    expect(await repo.existe(TEL)).toBe(true);
  });

  it("salvar grava o retrato da hora, não o objeto que muda depois", async () => {
    const armazem = await criar();
    const repo = new RepositorioConversas(armazem);
    const c = await repo.carregar(TEL);
    c.idsVistos.push("antes");
    const gravando = repo.salvar(c);
    c.idsVistos.push("depois");
    await gravando;
    expect((await new RepositorioConversas(armazem).carregar(TEL)).idsVistos).toEqual(["antes"]);
  });

  it("gravações seguidas da mesma conversa chegam em ordem", async () => {
    const armazem = await criar();
    const repo = new RepositorioConversas(armazem);
    const c = await repo.carregar(TEL);
    const promessas: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      c.idsVistos.push(`m${i}`);
      promessas.push(repo.salvar(c));
    }
    await Promise.all(promessas);
    expect((await new RepositorioConversas(armazem).carregar(TEL)).idsVistos.at(-1)).toBe("m19");
  });

  it("corta os ids vistos no limite", async () => {
    const armazem = await criar();
    const repo = new RepositorioConversas(armazem);
    const c = await repo.carregar(TEL);
    c.idsVistos = Array.from({ length: MAX_IDS_VISTOS + 5 }, (_, i) => `m${i}`);
    await repo.salvar(c);
    expect((await repo.carregar(TEL)).idsVistos).toHaveLength(MAX_IDS_VISTOS);
  });

  it("documento inválido é separado e vira conversa nova, com alerta", async () => {
    const armazem = await criar();
    await armazem.gravar(TEL, { versao: 1, estado: { telefone: TEL } });
    const eventos: Record<string, unknown>[] = [];
    const c = await new RepositorioConversas(armazem, (e) => eventos.push(e)).carregar(TEL);
    expect(c.turnos).toEqual([]);
    expect(eventos[0]).toMatchObject({ type: "alerta", motivo: "estado_corrompido" });
    expect(await armazem.ler(TEL)).toBeNull();
  });

  it("documento de outro telefone é tratado como corrompido", async () => {
    const armazem = await criar();
    const repo = new RepositorioConversas(armazem);
    const outra = await repo.carregar("5583888880000");
    await armazem.gravar(TEL, JSON.parse(JSON.stringify(outra)));
    expect((await repo.carregar(TEL)).estado.telefone).toBe(TEL);
    expect(await armazem.ler(TEL)).toBeNull();
  });

  it("telefone inválido é recusado antes de chegar ao armazém", async () => {
    const repo = new RepositorioConversas(await criar());
    await expect(repo.carregar("../etc")).rejects.toThrow(/telefone inválido/);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

Run: `npx vitest run tests/armazemConversas.test.ts`
Expected: FAIL (`Cannot find module '../src/conversas/armazem.js'`)

- [ ] **Passo 3: `src/conversas/armazem.ts`**

```ts
import type { Banco } from "../db/banco.js";

/** Só guarda e devolve o documento; validação e cortes ficam no RepositorioConversas. */
export interface ArmazemConversas {
  ler(telefone: string): Promise<unknown | null>;
  gravar(telefone: string, doc: unknown): Promise<void>;
  separarCorrompido(telefone: string, doc: unknown, erro: string): Promise<void>;
}

export class MemoriaConversas implements ArmazemConversas {
  private readonly docs = new Map<string, string>();
  readonly corrompidos: Array<{ telefone: string; erro: string }> = [];

  async ler(telefone: string): Promise<unknown | null> {
    const doc = this.docs.get(telefone);
    return doc === undefined ? null : JSON.parse(doc);
  }
  async gravar(telefone: string, doc: unknown): Promise<void> {
    this.docs.set(telefone, JSON.stringify(doc));
  }
  async separarCorrompido(telefone: string, _doc: unknown, erro: string): Promise<void> {
    this.docs.delete(telefone);
    this.corrompidos.push({ telefone, erro });
  }
}

export class PgConversas implements ArmazemConversas {
  constructor(private readonly banco: Banco) {}

  async ler(telefone: string): Promise<unknown | null> {
    const linhas = await this.banco.query<{ doc: unknown }>("SELECT doc FROM agente.conversas WHERE telefone = $1", [telefone]);
    return linhas[0]?.doc ?? null;
  }

  async gravar(telefone: string, doc: unknown): Promise<void> {
    await this.banco.query(
      `INSERT INTO agente.conversas (telefone, doc, atualizado_em) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (telefone) DO UPDATE SET doc = EXCLUDED.doc, atualizado_em = now()`,
      [telefone, JSON.stringify(doc)]
    );
  }

  async separarCorrompido(telefone: string, doc: unknown, erro: string): Promise<void> {
    await this.banco.transacao(async (tx) => {
      await tx.query("INSERT INTO agente.conversas_corrompidas (telefone, doc, erro) VALUES ($1, $2::jsonb, $3)", [
        telefone,
        JSON.stringify(doc),
        erro.slice(0, 500),
      ]);
      await tx.query("DELETE FROM agente.conversas WHERE telefone = $1", [telefone]);
    });
  }
}
```

- [ ] **Passo 4: `src/conversas/repositorio.ts` assíncrono**

Troque os imports de `fs`, `path` e `../util/arquivo.js` por `import type { ArmazemConversas } from "./armazem.js";`. As interfaces, constantes, `conversaSchema` e `novaConversa` ficam iguais. A classe fica assim:

```ts
const TELEFONE = /^\d{10,15}$/;

function exigirTelefone(telefone: string): void {
  if (!TELEFONE.test(telefone)) throw new Error("telefone inválido");
}

export class RepositorioConversas {
  /** Última gravação por telefone: a próxima espera a anterior, para não chegarem fora de ordem. */
  private readonly gravacoes = new Map<string, Promise<void>>();

  constructor(
    private readonly armazem: ArmazemConversas,
    private readonly log: (evento: Record<string, unknown>) => void = () => {}
  ) {}

  async existe(telefone: string): Promise<boolean> {
    exigirTelefone(telefone);
    return (await this.armazem.ler(telefone)) !== null;
  }

  async carregar(telefone: string): Promise<Conversa> {
    exigirTelefone(telefone);
    await this.gravacoes.get(telefone)?.catch(() => {});
    const bruto = await this.armazem.ler(telefone);
    if (bruto === null) return novaConversa(telefone);
    try {
      const c = conversaSchema.parse(bruto) as unknown as Conversa;
      if (c.estado.telefone !== telefone) throw new Error("documento de outro telefone");
      return c;
    } catch (err) {
      await this.armazem.separarCorrompido(telefone, bruto, String(err));
      this.log({ type: "alerta", gravidade: "alta", motivo: "estado_corrompido", tabela: "agente.conversas_corrompidas", erro: String(err).slice(0, 500) });
      return novaConversa(telefone);
    }
  }

  salvar(c: Conversa): Promise<void> {
    const telefone = c.estado.telefone;
    exigirTelefone(telefone);
    c.turnos = c.turnos.slice(-MAX_TURNOS_GUARDADOS);
    c.idsVistos = c.idsVistos.slice(-MAX_IDS_VISTOS);
    c.estado.historico = c.estado.historico.slice(-MAX_HISTORICO);
    if (c.estado.arquivosRecebidos) c.estado.arquivosRecebidos = c.estado.arquivosRecebidos.slice(-MAX_ARQUIVOS_RECEBIDOS);
    const falhas = Object.entries(c.falhasPorTurno);
    if (falhas.length > MAX_FALHAS_GUARDADAS) c.falhasPorTurno = Object.fromEntries(falhas.slice(-MAX_FALHAS_GUARDADAS));
    const retrato: unknown = JSON.parse(JSON.stringify(c));
    const anterior = this.gravacoes.get(telefone) ?? Promise.resolve();
    const esta = anterior.catch(() => {}).then(() => this.armazem.gravar(telefone, retrato));
    this.gravacoes.set(telefone, esta);
    void esta
      .finally(() => {
        if (this.gravacoes.get(telefone) === esta) this.gravacoes.delete(telefone);
      })
      .catch(() => {});
    return esta;
  }
}
```

(A mensagem "telefone inválido" substitui "telefone inválido para nome de arquivo"; ajuste o teste que conferia a antiga.)

- [ ] **Passo 5: rodar o contrato**

Run: `npx vitest run tests/armazemConversas.test.ts`
Expected: PASS (16 testes: 8 × 2 versões)

- [ ] **Passo 6: `AgenteDefinitivo` com `await`**

Em `src/api/agenteDefinitivo.ts`:
- Linha 75: `!(await this.deps.repo.existe(evento.telefone))`.
- `private conversa(telefone: string): Conversa` vira `private async conversa(telefone: string): Promise<Conversa>`, com `item = { conversa: await this.deps.repo.carregar(telefone), usadaEm: agora };`. Todo `this.conversa(` no arquivo ganha `await` (os chamadores já são `async`; confira com `grep -n "this.conversa(" src/api/agenteDefinitivo.ts`).
- Linhas 104, 213 e 270: `await this.deps.repo.salvar(conversa);`.
- Linha 168 (`aoEfeito` é síncrono no `runTurn`, e assim fica):

```ts
aoEfeito: () => {
  this.deps.repo.salvar(conversa).catch((err) => logger.log({ type: "conversa_nao_salva", erro: String(err).slice(0, 300) }));
},
```

A gravação do fim do turno (com `await`) espera esta, porque o repositório encadeia; uma falha aqui reaparece lá como falha do turno.

- Se o tipo de `deps.repo` estiver declarado como `RepositorioConversas`, nada muda nele.

- [ ] **Passo 7: o observador do CRM lê pelo armazém**

Em `src/whatsapp/crm.ts`, troque o parâmetro `conversasDir: string` do construtor por `lerConversa: (telefone: string) => Promise<unknown | null>`, apague o import de `readFile`/`join` se ficarem sem uso, e no `enviar`:

```ts
if (item.rota === "conversas") {
  try {
    corpo = await this.lerConversa(item.telefone);
  } catch {
    return false; // banco fora: tenta de novo depois
  }
  if (corpo === null) return true; // conversa ainda sem registro (ex.: só mensagens do atendente)
} else {
```

A ligação nos pontos de entrada (`new PgConversas(banco)`) é feita na Tarefa 5, junto com os outros stores. Até lá, em `src/whatsapp/index.ts:35` e `src/api/index.ts:60`, abra o banco no começo do `main()` (`const banco = await abrirBanco();`) e use:
- API: `repo: new RepositorioConversas(new PgConversas(banco), log)`
- Ponte: `new ObservadorCrm(config.crm.url, config.crm.segredo, (t) => new PgConversas(banco).ler(t), log)`

- [ ] **Passo 8: os testes antigos**

Reescreva `tests/repositorioConversas.test.ts`: os casos que o contrato do Passo 1 já cobre saem; os outros (opções apresentadas sobrevivem, cortes de histórico, de arquivos recebidos e de falhas) ficam, trocando `new RepositorioConversas(dir)` por `new RepositorioConversas(new MemoriaConversas())`, com `await` em `carregar`/`salvar`/`existe`. O que conferia `.tmp` ou nome de arquivo sai.

Nos outros testes que constroem o repositório (lista do grep), mesma troca. Nos testes do `ObservadorCrm`, passe `async (t) => conversas.get(t) ?? null` no lugar da pasta.

- [ ] **Passo 9: tudo verde e commit**

Run: `npm run typecheck` e `npx vitest run`
Expected: limpo e verde.

```bash
git add -A src/conversas src/api src/whatsapp/crm.ts src/whatsapp/index.ts tests
git commit -m "feat(banco): conversas no Postgres, com gravação em ordem por telefone"
```

---

### Tarefa 3: estado da ponte e modo da Lia no banco

**Arquivos:**
- Modificar: `src/whatsapp/estadoPonte.ts`, `src/whatsapp/modoLia.ts`, `src/whatsapp/ponte.ts:117-130,208-228`, `src/whatsapp/controle.ts:54,65,70`, `src/whatsapp/index.ts:25-55`, `tests/estadoPonte.test.ts`, `tests/ponteRegressoes.test.ts` e os testes do modo da Lia/controle (ache com `grep -rln "ArquivoModoLia\|ArquivoEstadoPonte\|armazem:" tests`)

**Interfaces:**
- Consome: `Banco`, `bancoDeTeste`, `logarErroBanco`
- Produz:
  - `interface ArmazemPonte { carregar(): Promise<EstadoPonte>; salvar(e: EstadoPonte): Promise<void> }`
  - `normalizarEstadoPonte(bruto: unknown): EstadoPonte` (lança erro se o formato for inesperado)
  - `class PgEstadoPonte implements ArmazemPonte` (`constructor(banco: Banco, log?: LogPonte)`)
  - `interface ArmazemModoLia { ler(): Promise<ConfigLia>; salvar(c: Omit<ConfigLia, "atualizadoEm">): Promise<ConfigLia> }`
  - `class MemoriaModoLia`, `class PgModoLia` (`constructor(banco: Banco, padrao: ConfigLia)`)
  - `OpcoesPonte.estadoInicial?: EstadoPonte`; `Ponte.salvarAgora(): Promise<void>`

- [ ] **Passo 1: testes que falham**

Em `tests/estadoPonte.test.ts`, troque os casos de `ArquivoEstadoPonte` por um `describe.each` igual ao da Tarefa 2, com `["memória", () => new MemoriaEstadoPonte()]` e `["postgres", async () => new PgEstadoPonte((banco = await bancoDeTeste()))]`:

```ts
it("sem registro → estado vazio", async () => {
  expect(await (await criar()).carregar()).toEqual(estadoVazio());
});

it("salva e relê", async () => {
  const a = await criar();
  const e = { ...estadoVazio(), modos: { "5583999990000": "humano" as const }, concluidos: ["m1"] };
  await a.salvar(e);
  expect(await a.carregar()).toEqual(e);
});
```

E só para o Postgres:

```ts
it("documento inválido no banco → estado vazio e alerta", async () => {
  banco = await bancoDeTeste();
  await banco.query("INSERT INTO agente.estado_ponte (id, doc) VALUES (1, '{\"versao\": 9}')");
  const eventos: Record<string, unknown>[] = [];
  expect(await new PgEstadoPonte(banco, (e) => eventos.push(e)).carregar()).toEqual(estadoVazio());
  expect(eventos[0]).toMatchObject({ motivo: "estado_da_ponte_corrompido" });
});
```

Para o modo da Lia, num `tests/modoLiaBanco.test.ts` com o mesmo `describe.each` (`MemoriaModoLia` / `PgModoLia`):

```ts
const PADRAO = { modo: "teste" as const, numerosTeste: ["5583999990000"], atualizadoEm: null };

it("sem registro → padrão", async () => {
  expect(await (await criar(PADRAO)).ler()).toEqual(PADRAO);
});

it("salva com data e relê", async () => {
  const a = await criar(PADRAO);
  const salvo = await a.salvar({ modo: "ligada", numerosTeste: [] });
  expect(salvo.atualizadoEm).toMatch(/^\d{4}-/);
  expect(await a.ler()).toEqual(salvo);
});

```

(Assinatura da fábrica neste arquivo: `criar(padrao: ConfigLia): Promise<ArmazemModoLia>`.) E só no Postgres, fora do `describe.each`:

```ts
it("registro inválido no banco → padrão", async () => {
  banco = await bancoDeTeste();
  await banco.query(`INSERT INTO agente.modo_lia (id, config) VALUES (1, '{"modo": "x"}')`);
  expect(await new PgModoLia(banco, PADRAO).ler()).toEqual(PADRAO);
});
```

Em `tests/ponteRegressoes.test.ts`, que já tem o helper `montar(extra)` (linha 22) e usa timers falsos (`vi.runAllTimersAsync`):

```ts
it("salvarAgora devolve a gravação, para a saída do processo esperar", async () => {
  let gravou = false;
  const armazem: ArmazemPonte = {
    carregar: async () => estadoVazio(),
    salvar: async () => {
      await Promise.resolve();
      gravou = true;
    },
  };
  const { ponte } = montar({ armazem });
  await ponte.salvarAgora();
  expect(gravou).toBe(true);
});
```

- [ ] **Passo 2: rodar e ver falhar**

Run: `npx vitest run tests/estadoPonte.test.ts tests/modoLiaBanco.test.ts tests/ponteRegressoes.test.ts`
Expected: FAIL (`PgEstadoPonte` e `PgModoLia` não existem)

- [ ] **Passo 3: `src/whatsapp/estadoPonte.ts`**

- `ArmazemPonte` vira assíncrono (assinatura acima). `MemoriaEstadoPonte.carregar`/`salvar` ganham `async`.
- Extraia o miolo do `ArquivoEstadoPonte.carregar` para:

```ts
export function normalizarEstadoPonte(bruto: unknown): EstadoPonte {
  const e = bruto as EstadoPonte;
  if (
    e?.versao !== 1 ||
    !Array.isArray(e.concluidos) ||
    !Array.isArray(e.eventosPendentes) ||
    !Array.isArray(e.avisosPendentes) ||
    typeof e.modos !== "object" ||
    e.modos === null
  ) {
    throw new Error("formato inesperado");
  }
  e.entregasParciais = entregasValidas(e.entregasParciais);
  return e;
}
```

- Apague `ArquivoEstadoPonte` e os imports de `path`/`../util/arquivo.js` que sobrarem.
- Acrescente:

```ts
export class PgEstadoPonte implements ArmazemPonte {
  constructor(
    private readonly banco: Banco,
    private readonly log: LogPonte = () => {}
  ) {}

  async carregar(): Promise<EstadoPonte> {
    const [linha] = await this.banco.query<{ doc: unknown }>("SELECT doc FROM agente.estado_ponte WHERE id = 1");
    if (!linha) return estadoVazio();
    try {
      return normalizarEstadoPonte(linha.doc);
    } catch (err) {
      this.log({ type: "alerta", gravidade: "alta", motivo: "estado_da_ponte_corrompido", erro: String(err) });
      return estadoVazio();
    }
  }

  async salvar(estado: EstadoPonte): Promise<void> {
    await this.banco.query(
      `INSERT INTO agente.estado_ponte (id, doc, atualizado_em) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, atualizado_em = now()`,
      [JSON.stringify(estado)]
    );
  }
}
```

(import: `import type { Banco } from "../db/banco.js";`)

- [ ] **Passo 4: `src/whatsapp/modoLia.ts`**

Apague `ArquivoModoLia` e os imports de `fs`/`path` que sobrarem. Acrescente:

```ts
export interface ArmazemModoLia {
  ler(): Promise<ConfigLia>;
  salvar(config: Omit<ConfigLia, "atualizadoEm">): Promise<ConfigLia>;
}

function lerSalvo(salvo: unknown, padrao: ConfigLia): ConfigLia {
  if (!salvo || typeof salvo !== "object") return padrao;
  const valido = validarConfigLia(salvo as Record<string, unknown>);
  if (typeof valido === "string") return padrao;
  const em = (salvo as Record<string, unknown>).atualizadoEm;
  return { ...valido, atualizadoEm: typeof em === "string" ? em : null };
}

export class MemoriaModoLia implements ArmazemModoLia {
  private salvo: ConfigLia | null = null;
  constructor(private readonly padrao: ConfigLia) {}
  async ler(): Promise<ConfigLia> {
    return this.salvo ?? this.padrao;
  }
  async salvar(config: Omit<ConfigLia, "atualizadoEm">): Promise<ConfigLia> {
    this.salvo = { ...config, atualizadoEm: new Date().toISOString() };
    return this.salvo;
  }
}

export class PgModoLia implements ArmazemModoLia {
  constructor(
    private readonly banco: Banco,
    private readonly padrao: ConfigLia
  ) {}

  async ler(): Promise<ConfigLia> {
    const [linha] = await this.banco.query<{ config: unknown }>("SELECT config FROM agente.modo_lia WHERE id = 1");
    return lerSalvo(linha?.config, this.padrao);
  }

  async salvar(config: Omit<ConfigLia, "atualizadoEm">): Promise<ConfigLia> {
    const completo: ConfigLia = { ...config, atualizadoEm: new Date().toISOString() };
    await this.banco.query(
      `INSERT INTO agente.modo_lia (id, config, atualizado_em) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, atualizado_em = now()`,
      [JSON.stringify(completo)]
    );
    return completo;
  }
}
```

Em `src/whatsapp/controle.ts`: o tipo `lia: ArquivoModoLia` vira `lia: ArmazemModoLia`; linha 65 `responder(res, 200, await lia.ler())`; linha 70 `const salvo = await lia.salvar(valido);` (o handler que as contém precisa ser `async`; se não for, torne-o, e mantenha o tratamento de erro que já existe: o erro do banco responde 500).

- [ ] **Passo 5: `src/whatsapp/ponte.ts`**

Em `OpcoesPonte`, acrescente `estadoInicial?: EstadoPonte;`. No construtor, troque `const salvo = this.armazem.carregar();` por `const salvo = opcoes.estadoInicial ?? estadoVazio();` (importe `estadoVazio`). Acrescente o campo `private gravacao: Promise<void> = Promise.resolve();` e reescreva `salvarAgora`:

```ts
/** Grava o estado já (na saída do processo); no dia a dia ele é gravado logo depois de cada mudança. */
salvarAgora(): Promise<void> {
  if (this.salvamento) clearTimeout(this.salvamento);
  this.salvamento = undefined;
  const { modos, pendentes } = this.atendimento.instantaneo();
  const estado: EstadoPonte = {
    versao: 1,
    modos,
    eventosPendentes: pendentes,
    avisosPendentes: [...this.avisosPendentes],
    concluidos: this.concluidos.valores().slice(-CONCLUIDOS_GUARDADOS),
    entregasParciais: Object.fromEntries([...this.entregasParciais].slice(-ENTREGAS_PARCIAIS_GUARDADAS)),
  };
  this.gravacao = this.gravacao
    .then(() => this.armazem.salvar(estado))
    .catch((err) => this.log({ type: "estado_nao_salvo", erro: String(err) }));
  return this.gravacao;
}
```

As chamadas `this.salvarAgora();` do meio do fluxo (linha 394 e o `setTimeout` da 228) continuam sem `await`: a cadeia garante a ordem.

- [ ] **Passo 6: `src/whatsapp/index.ts`**

No começo do `main()`, `const banco = await abrirBanco();` (se a Tarefa 2 já pôs, reaproveite). Depois:

```ts
const armazem = new PgEstadoPonte(banco, log);
const estadoInicial = await armazem.carregar();
```

Na `new Ponte(...)`: `armazem, estadoInicial,` no lugar de `armazem: new ArquivoEstadoPonte(w.estadoArquivo, log),`.

```ts
const lia = new PgModoLia(banco, configLiaPadrao(w.liberados));
const modo = await lia.ler();
```

E a saída:

```ts
const sair = () => {
  void ponte
    .salvarAgora()
    .finally(() => canal.encerrar())
    .finally(() => banco.fechar())
    .finally(() => process.exit(0));
};
```

Em `src/config.ts`, apague `estadoArquivo` e `modoLiaArquivo` (linhas 90 e 95) e as linhas correspondentes no `.env.example`, se existirem.

- [ ] **Passo 7: testes antigos da ponte**

Em `tests/ponteRegressoes.test.ts:414`, o `reiniciar` passa a ler o estado antes de montar:

```ts
async function reiniciar(armazem: MemoriaEstadoPonte) {
  return montar({ armazem, estadoInicial: await armazem.carregar() });
}
```

Cada `const depois = reiniciar(armazem);` vira `const depois = await reiniciar(armazem);`. Antes de reiniciar, chame `await antes.ponte.salvarAgora();` onde o teste dependia da gravação do timer (o `vi.runAllTimersAsync()` dispara o timer, mas a gravação agora é uma promessa). O mesmo vale para `tests/ponte.test.ts`, `tests/modoLia.test.ts` e `tests/observadorPonte.test.ts`: onde montam a `Ponte` com um armazém que já tem estado, passe `estadoInicial`. Onde liam `memoria.estado` depois de salvar, ponha `await ponte.salvarAgora()` antes de conferir. Em `tests/modoLia.test.ts`, `ArquivoModoLia` vira `MemoriaModoLia`, com `await` em `ler`/`salvar`.

- [ ] **Passo 8: tudo verde e commit**

Run: `npm run typecheck` e `npx vitest run`
Expected: limpo e verde.

```bash
git add -A src/whatsapp src/config.ts .env.example tests
git commit -m "feat(banco): estado da ponte e modo da Lia no Postgres"
```

---

### Tarefa 4: interruptor de suspensão no banco

**Arquivos:**
- Modificar: `src/controle/estadoSistema.ts`, `src/whatsapp/atendente.ts:72-90`, `src/api/index.ts`, `src/whatsapp/index.ts`, os testes que usam `escreverEstadoSistema`/`invalidarCache` (ache com `grep -rln "estadoSistema" tests`)
- Criar: `tests/estadoSistemaBanco.test.ts`

**Interfaces:**
- Consome: `Banco`, `bancoDeTeste`, `logarErroBanco`
- Produz:
  - `lerEstadoSistema(): EstadoSistema` continua **síncrona** (é chamada a cada turno), lendo o cache.
  - `ligarEstadoSistema(banco: Banco, intervaloMs?: number): Promise<() => void>`: lê agora, relê a cada `intervaloMs` (padrão 30 000) e devolve a função que para a releitura.
  - `escreverEstadoSistema(estado: EstadoSistema): Promise<void>`: atualiza o cache na hora e grava no banco, se ligado.
  - `invalidarCache()` continua, para os testes (volta ao estado "não suspenso" e desliga o banco).

O que muda: o API e a ponte são processos diferentes. O que um grava, o outro vê na próxima releitura (até 30 s, o mesmo `CACHE_MS` de hoje).

- [ ] **Passo 1: o teste que falha** (`tests/estadoSistemaBanco.test.ts`)

```ts
import { describe, it, expect, afterEach } from "vitest";
import { escreverEstadoSistema, invalidarCache, lerEstadoSistema, ligarEstadoSistema } from "../src/controle/estadoSistema.js";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";

describe("estado do sistema no banco", () => {
  let banco: Banco | undefined;
  let parar: (() => void) | undefined;
  afterEach(async () => {
    parar?.();
    invalidarCache();
    await banco?.fechar();
    banco = undefined;
  });

  it("sem registro → não suspenso", async () => {
    banco = await bancoDeTeste();
    parar = await ligarEstadoSistema(banco, 60_000);
    expect(lerEstadoSistema()).toEqual({ suspenso: false });
  });

  it("o que um processo grava, o outro lê na releitura", async () => {
    banco = await bancoDeTeste();
    parar = await ligarEstadoSistema(banco, 10);
    await banco.query(`INSERT INTO agente.estado_sistema (id, estado) VALUES (1, '{"suspenso": true, "suspensoPor": "teste"}')`);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(lerEstadoSistema()).toMatchObject({ suspenso: true, suspensoPor: "teste" });
  });

  it("escrever vale na hora e fica no banco", async () => {
    banco = await bancoDeTeste();
    parar = await ligarEstadoSistema(banco, 60_000);
    await escreverEstadoSistema({ suspenso: true, suspensoPor: "atendente" });
    expect(lerEstadoSistema().suspenso).toBe(true);
    const [linha] = await banco.query<{ estado: { suspenso: boolean } }>("SELECT estado FROM agente.estado_sistema");
    expect(linha.estado.suspenso).toBe(true);
  });

  it("falha de leitura mantém o último estado (não dessuspende sozinho)", async () => {
    banco = await bancoDeTeste();
    parar = await ligarEstadoSistema(banco, 10);
    await escreverEstadoSistema({ suspenso: true });
    await banco.query("DROP TABLE agente.estado_sistema");
    await new Promise((ok) => setTimeout(ok, 50));
    expect(lerEstadoSistema().suspenso).toBe(true);
  });

  it("registro com formato inválido → não suspenso", async () => {
    banco = await bancoDeTeste();
    await banco.query(`INSERT INTO agente.estado_sistema (id, estado) VALUES (1, '{"suspenso": "sim"}')`);
    parar = await ligarEstadoSistema(banco, 60_000);
    expect(lerEstadoSistema()).toEqual({ suspenso: false });
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

Run: `npx vitest run tests/estadoSistemaBanco.test.ts`
Expected: FAIL (`ligarEstadoSistema` não existe)

- [ ] **Passo 3: `src/controle/estadoSistema.ts`**

Substitua o arquivo inteiro por:

```ts
import type { Banco } from "../db/banco.js";
import { logarErroBanco } from "../db/banco.js";

const RELEITURA_MS = 30_000;

export interface EstadoSistema {
  suspenso: boolean;
  suspensoPor?: string;
  suspensoEm?: string;
  /** Ferramentas desligadas em runtime (complementa FERRAMENTAS_DESLIGADAS do .env). */
  ferramentasDesligadas?: string[];
}

let atual: EstadoSistema = { suspenso: false };
let banco: Banco | null = null;

function valido(bruto: unknown): EstadoSistema {
  if (!bruto || typeof bruto !== "object" || typeof (bruto as Record<string, unknown>).suspenso !== "boolean") {
    return { suspenso: false };
  }
  return bruto as EstadoSistema;
}

async function reler(): Promise<void> {
  if (!banco) return;
  try {
    const [linha] = await banco.query<{ estado: unknown }>("SELECT estado FROM agente.estado_sistema WHERE id = 1");
    atual = linha ? valido(linha.estado) : { suspenso: false };
  } catch (err) {
    // Sem banco, vale o último estado lido: suspenso não pode virar ativo por falha de leitura.
    console.error(JSON.stringify({ type: "estado_sistema_nao_lido", ...logarErroBanco(err) }));
  }
}

export async function ligarEstadoSistema(b: Banco, intervaloMs = RELEITURA_MS): Promise<() => void> {
  banco = b;
  await reler();
  const t = setInterval(() => void reler(), intervaloMs);
  t.unref();
  return () => clearInterval(t);
}

export function lerEstadoSistema(): EstadoSistema {
  return atual;
}

export async function escreverEstadoSistema(estado: EstadoSistema): Promise<void> {
  atual = estado;
  if (!banco) return;
  await banco.query(
    `INSERT INTO agente.estado_sistema (id, estado, atualizado_em) VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET estado = EXCLUDED.estado, atualizado_em = now()`,
    [JSON.stringify(estado)]
  );
}

/** Volta ao padrão e desliga o banco. Usado nos testes. */
export function invalidarCache(): void {
  atual = { suspenso: false };
  banco = null;
}
```

`arquivoEstadoSistema()` sai. Procure quem a usa (`grep -rn "arquivoEstadoSistema\|ESTADO_SISTEMA_ARQUIVO" src scripts tests .env.example`) e remova esses usos; se `verificacaoAmbiente.ts` conferia o arquivo, troque pela checagem de que `AGENTE_DATABASE_URL` está definida.

- [ ] **Passo 4: quem escreve**

Em `src/whatsapp/atendente.ts:78-90`, cada `escreverEstadoSistema(...)` ganha `await` (a função que os contém já é `async`, ou passa a ser). Se a gravação falhar, o erro sobe para quem tratava o comando do atendente e o log já existente registra; não engula.

- [ ] **Passo 5: ligar nos processos**

Em `src/api/index.ts` e `src/whatsapp/index.ts`, logo depois de `abrirBanco()`: `await ligarEstadoSistema(banco);`.

- [ ] **Passo 6: testes antigos**

Os testes que gravavam o arquivo do estado (`ESTADO_SISTEMA_ARQUIVO`, `escreverEstadoSistema(estado, arquivo)`) passam a chamar `await escreverEstadoSistema(estado)` sem arquivo. Sem banco ligado, ela só muda o valor em memória, que é o que o teste precisa. Mantenha `invalidarCache()` no `afterEach`.

- [ ] **Passo 7: tudo verde e commit**

Run: `npm run typecheck` e `npx vitest run`
Expected: limpo e verde.

```bash
git add -A src/controle src/whatsapp/atendente.ts src/api/index.ts src/whatsapp/index.ts src/operacao tests .env.example
git commit -m "feat(banco): interruptor de suspensão no Postgres"
```

---

### Tarefa 5: lacunas e pedidos no banco, e `ligarStores`

**Arquivos:**
- Modificar: `src/knowledge/lacunas.ts`, `src/integrations/brindeme/orderIndex.ts:36-75,97-170`, `src/tools/consultarConhecimento.ts:49-51,66`, `src/tools/consultarPedido.ts:55-57`, `scripts/lacunas.ts`, `scripts/syncPedidos.ts`, `src/api/index.ts`, `src/cli.ts`, `evals/ambiente.ts`, os testes de lacunas e pedidos (ache com `grep -rln "LacunaStore\|OrderIndexStore\|localizarPedido\|sincronizarPedidos" tests evals`)
- Criar: `src/db/stores.ts`, `tests/lacunasBanco.test.ts`, `tests/pedidosBanco.test.ts`

**Interfaces:**
- Consome: `Banco`, `bancoDeTeste`, `logarErroBanco`, `PgConversas`
- Produz:
  - `interface LacunaStore { registrar(l: Lacuna): Promise<void>; listar(): Promise<Lacuna[]> }`; `registrar` **nunca rejeita** (como hoje: lacuna não derruba atendimento).
  - `class PgLacunaStore implements LacunaStore` (`constructor(banco: Banco)`)
  - `interface OrderIndexStore { carregar(): Promise<PedidoIndexado[]>; salvar(p: PedidoIndexado[]): Promise<void> }`
  - `class PgOrderIndexStore implements OrderIndexStore`
  - `localizarPedido(...)` passa a ser `async` (mesmos parâmetros)
  - `ligarStores(banco: Banco): void` em `src/db/stores.ts`: chama `setLacunaStore` e `setOrderIndexStore` com as versões Pg.
  - Os getters das tools, sem store definido, **lançam** `Error("store de <x> não ligado: chame ligarStores(banco) na partida")`.

- [ ] **Passo 1: testes que falham**

`tests/lacunasBanco.test.ts`, com o `describe.each` (`MemoryLacunaStore` / `PgLacunaStore`):

```ts
it("registra e lista na ordem", async () => {
  const s = await criar();
  await s.registrar({ pergunta: "p1", conversa_id: "c1", registrado_em: "2026-11-10T10:00:00.000Z" });
  await s.registrar({ pergunta: "p2", conversa_id: "c2", categoria_sugerida: "prazo", registrado_em: "2026-11-10T11:00:00.000Z" });
  expect(await s.listar()).toEqual([
    { pergunta: "p1", conversa_id: "c1", registrado_em: "2026-11-10T10:00:00.000Z" },
    { pergunta: "p2", conversa_id: "c2", categoria_sugerida: "prazo", registrado_em: "2026-11-10T11:00:00.000Z" },
  ]);
});
```

E só no Postgres:

```ts
it("registrar não rejeita com o banco fora", async () => {
  banco = await bancoDeTeste();
  const s = new PgLacunaStore(banco);
  await banco.query("DROP TABLE agente.lacunas");
  await expect(s.registrar({ pergunta: "p", conversa_id: "c", registrado_em: new Date().toISOString() })).resolves.toBeUndefined();
});
```

`tests/pedidosBanco.test.ts`, com o `describe.each` (`MemoryOrderIndexStore` / `PgOrderIndexStore`):

```ts
const P = (id: string, codigo: string) => ({
  id, codigo, telefone: "5583999990000", email: "a@b.com", status: "aberto",
  criado_em: "2026-11-01T00:00:00.000Z", sincronizado_em: "2026-11-10T00:00:00.000Z",
});

it("vazio no começo", async () => {
  expect(await (await criar()).carregar()).toEqual([]);
});

it("salvar substitui a lista inteira", async () => {
  const s = await criar();
  await s.salvar([P("1", "A1"), P("2", "A2")]);
  await s.salvar([P("2", "A2-novo")]);
  expect(await s.carregar()).toEqual([P("2", "A2-novo")]);
});
```

- [ ] **Passo 2: rodar e ver falhar**

Run: `npx vitest run tests/lacunasBanco.test.ts tests/pedidosBanco.test.ts`
Expected: FAIL

- [ ] **Passo 3: `src/knowledge/lacunas.ts`**

`LacunaStore` assíncrona; `MemoryLacunaStore` com `async`; `FileLacunaStore` sai (e os imports de `fs` e `__dir`, se sobrarem só para ela). Acrescente:

```ts
export class PgLacunaStore implements LacunaStore {
  constructor(private readonly banco: Banco) {}

  async registrar(l: Lacuna): Promise<void> {
    try {
      await this.banco.query(
        "INSERT INTO agente.lacunas (conversa_id, pergunta, categoria_sugerida, registrado_em) VALUES ($1, $2, $3, $4)",
        [l.conversa_id, l.pergunta, l.categoria_sugerida ?? null, l.registrado_em]
      );
    } catch (err) {
      // Registrar lacuna não pode derrubar o atendimento.
      console.error(JSON.stringify({ type: "lacuna_nao_registrada", ...logarErroBanco(err) }));
    }
  }

  async listar(): Promise<Lacuna[]> {
    const linhas = await this.banco.query<{ conversa_id: string; pergunta: string; categoria_sugerida: string | null; registrado_em: Date }>(
      "SELECT conversa_id, pergunta, categoria_sugerida, registrado_em FROM agente.lacunas ORDER BY registrado_em, id"
    );
    return linhas.map((r) => ({
      pergunta: r.pergunta,
      conversa_id: r.conversa_id,
      ...(r.categoria_sugerida ? { categoria_sugerida: r.categoria_sugerida } : {}),
      registrado_em: new Date(r.registrado_em).toISOString(),
    }));
  }
}
```

(O `pg` e o pglite devolvem `TIMESTAMPTZ` como `Date`; o `new Date(...)` cobre os dois.)

- [ ] **Passo 4: `src/integrations/brindeme/orderIndex.ts`**

`OrderIndexStore` assíncrona; `MemoryOrderIndexStore` com `async`; `FileOrderIndexStore` sai. Em `sincronizarPedidos`: `await store.carregar()` (linha 109) e `await store.salvar(...)` (linha 145). `localizarPedido` vira `export async function` com `(await store.carregar()).find(...)` (linha 166); acerte o retorno para `Promise<...>`. Acrescente:

```ts
export class PgOrderIndexStore implements OrderIndexStore {
  constructor(private readonly banco: Banco) {}

  async carregar(): Promise<PedidoIndexado[]> {
    return this.banco.query<PedidoIndexado>(
      "SELECT id, codigo, telefone, email, status, criado_em, sincronizado_em FROM agente.pedidos ORDER BY criado_em, id"
    );
  }

  async salvar(pedidos: PedidoIndexado[]): Promise<void> {
    await this.banco.transacao(async (tx) => {
      await tx.query("DELETE FROM agente.pedidos");
      if (pedidos.length === 0) return;
      await tx.query(
        `INSERT INTO agente.pedidos (id, codigo, telefone, email, status, criado_em, sincronizado_em)
         SELECT id, codigo, telefone, email, status, criado_em, sincronizado_em
         FROM jsonb_to_recordset($1::jsonb) AS p(id TEXT, codigo TEXT, telefone TEXT, email TEXT, status TEXT, criado_em TEXT, sincronizado_em TEXT)`,
        [JSON.stringify(pedidos)]
      );
    });
  }
}
```

(O teste "salvar substitui" espera a ordem de inserção; com `ORDER BY criado_em, id` e o mesmo `criado_em`, a ordem sai por `id`. Use ids em ordem nos testes.)

- [ ] **Passo 5: as tools e `ligarStores`**

Em `src/tools/consultarConhecimento.ts`:

```ts
function getLacunas(): LacunaStore {
  if (!lacunasPadrao) throw new Error("store de lacunas não ligado: chame ligarStores(banco) na partida");
  return lacunasPadrao;
}
```

Linha 66: `await getLacunas().registrar(criarLacuna(input.pergunta, state.conversaId, input.categoria));`

Em `src/tools/consultarPedido.ts`, o mesmo para `getStore()` ("store de pedidos não ligado: ..."), e `await` em cada `localizarPedido(` / `getStore().carregar()` do arquivo.

`src/db/stores.ts`:

```ts
import type { Banco } from "./banco.js";
import { PgLacunaStore } from "../knowledge/lacunas.js";
import { PgOrderIndexStore } from "../integrations/brindeme/orderIndex.js";
import { setLacunaStore } from "../tools/consultarConhecimento.js";
import { setOrderIndexStore } from "../tools/consultarPedido.js";

/** Liga nas tools os stores do banco. Toda entrada que atende cliente chama isto depois de abrirBanco(). */
export function ligarStores(banco: Banco): void {
  setLacunaStore(new PgLacunaStore(banco));
  setOrderIndexStore(new PgOrderIndexStore(banco));
}
```

(O catálogo entra aqui na Tarefa 9.)

- [ ] **Passo 6: as entradas**

- `src/api/index.ts`: depois de `abrirBanco()` e `ligarEstadoSistema`, `ligarStores(banco);`.
- `src/cli.ts`: abra o banco no começo (`const banco = await abrirBanco();`), chame `await ligarEstadoSistema(banco)` e `ligarStores(banco)`; se o chat do terminal usa `RepositorioConversas`, passe `new PgConversas(banco)`.
- `scripts/lacunas.ts`: `const banco = await abrirBanco(); const lacunas = await new PgLacunaStore(banco).listar();` … e `await banco.fechar()` no fim.
- `scripts/syncPedidos.ts`: `const store = new PgOrderIndexStore(await abrirBanco());` (o script continua proibido de rodar com dados reais; só compila).
- `evals/ambiente.ts`: nada muda nos setters (já põe `Memory*`); acerte os `await` nas chamadas a `sincronizarPedidos` e afins.

Em `src/config.ts`, apague `orcamentosTesteArquivo` (linhas 52-53), e o ramo de orçamentos de teste sai na Tarefa 6.

- [ ] **Passo 7: testes antigos**

Nos testes de lacunas, pedidos e `consultarPedido`, `await` em `listar`, `carregar`, `salvar`, `localizarPedido`. Testes que dependiam do `File*` padrão das tools passam a chamar `setLacunaStore(new MemoryLacunaStore())` / `setOrderIndexStore(new MemoryOrderIndexStore())` no `beforeEach`. Se o erro "store de ... não ligado" aparecer num teste, é isso que falta.

- [ ] **Passo 8: tudo verde e commit**

Run: `npm run typecheck` e `npx vitest run`
Expected: limpo e verde.

```bash
git add -A src scripts evals tests
git commit -m "feat(banco): lacunas e pedidos no Postgres, stores ligados na partida"
```

---

### Tarefa 6: retenção no banco

**Arquivos:**
- Criar: `src/operacao/retencaoBanco.ts`, `tests/retencaoBanco.test.ts`
- Modificar: `src/operacao/retencao.ts`, `scripts/limparDados.ts`, os testes de retenção (`grep -rln "selecionarParaLimpeza\|selecionarCliente" tests`)

**Interfaces:**
- Consome: `Banco`, `bancoDeTeste`
- Produz (em `retencaoBanco.ts`):
  - `interface PlanoBanco { telefones: string[]; conversaIds: string[]; lacunas: number; registrosPonte: number }`
  - `planejarPorIdade(banco: Banco, dias: number, agora?: number): Promise<PlanoBanco>`
  - `planejarCliente(banco: Banco, telefone: string): Promise<PlanoBanco>`
  - `executarPlano(banco: Banco, plano: PlanoBanco, porIdade: { dias: number; agora: number } | null): Promise<void>`
  - `telefonesAtivos(banco: Banco, dias: number, agora?: number): Promise<Set<string>>`
  - `tirarTelefonesDoEstadoPonte(estado: EstadoPonte, telefones: string[]): { estado: EstadoPonte; registros: number }`
- Muda (em `retencao.ts`): `PastasRetencao` fica só com `artes` e `logs`; `selecionarParaLimpeza(pastas, dias, agora, conversasVivas: Set<string>)` cuida só de artes e logs; `selecionarCliente(pastas, telefone, conversaId: string | undefined, agora?)` também.

Regras que não podem mudar (da `retencao.ts` atual):
- sem `--executar`, nada sai;
- prazo mínimo de 1 dia;
- as artes de um telefone só saem se a conversa dele também saiu (ou não existe) **e** a arte mais nova passou do prazo;
- do estado da ponte, só sai o telefone cuja conversa também está saindo;
- `api.jsonl` nunca sai;
- por cliente (LGPD): sai tudo dele, mesmo com a conversa ativa.

- [ ] **Passo 1: o teste que falha** (`tests/retencaoBanco.test.ts`)

```ts
import { describe, it, expect, afterEach } from "vitest";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";
import { executarPlano, planejarCliente, planejarPorIdade, tirarTelefonesDoEstadoPonte } from "../src/operacao/retencaoBanco.js";
import { estadoVazio } from "../src/whatsapp/estadoPonte.js";

const DIA = 86_400_000;
const AGORA = Date.parse("2026-11-10T12:00:00Z");
const VELHO = "5583900000001";
const NOVO = "5583900000002";

async function semear(banco: Banco): Promise<void> {
  const doc = (tel: string, id: string) => JSON.stringify({ versao: 1, estado: { telefone: tel, conversaId: id } });
  await banco.query("INSERT INTO agente.conversas (telefone, doc, atualizado_em) VALUES ($1, $2::jsonb, $3)", [VELHO, doc(VELHO, "c-velho"), new Date(AGORA - 100 * DIA)]);
  await banco.query("INSERT INTO agente.conversas (telefone, doc, atualizado_em) VALUES ($1, $2::jsonb, $3)", [NOVO, doc(NOVO, "c-novo"), new Date(AGORA - 1 * DIA)]);
  await banco.query("INSERT INTO agente.lacunas (conversa_id, pergunta, registrado_em) VALUES ('c-velho', 'p', $1), ('c-novo', 'p', $2)", [new Date(AGORA - 100 * DIA), new Date(AGORA - 1 * DIA)]);
  const ponte = { ...estadoVazio(), modos: { [VELHO]: "humano", [NOVO]: "ia" }, eventosPendentes: [{ telefone: VELHO }] };
  await banco.query("INSERT INTO agente.estado_ponte (id, doc) VALUES (1, $1::jsonb)", [JSON.stringify(ponte)]);
}

describe("retenção no banco", () => {
  let banco: Banco | undefined;
  afterEach(async () => {
    await banco?.fechar();
    banco = undefined;
  });

  it("por idade: lista sem apagar", async () => {
    banco = await bancoDeTeste();
    await semear(banco);
    const plano = await planejarPorIdade(banco, 90, AGORA);
    expect(plano).toEqual({ telefones: [VELHO], conversaIds: ["c-velho"], lacunas: 1, registrosPonte: 2 });
    expect(await banco.query("SELECT telefone FROM agente.conversas")).toHaveLength(2);
  });

  it("por idade: executar apaga só o velho", async () => {
    banco = await bancoDeTeste();
    await semear(banco);
    await executarPlano(banco, await planejarPorIdade(banco, 90, AGORA), { dias: 90, agora: AGORA });
    expect((await banco.query<{ telefone: string }>("SELECT telefone FROM agente.conversas")).map((r) => r.telefone)).toEqual([NOVO]);
    expect(await banco.query("SELECT 1 FROM agente.lacunas")).toHaveLength(1);
    const [ponte] = await banco.query<{ doc: { modos: Record<string, string>; eventosPendentes: unknown[] } }>("SELECT doc FROM agente.estado_ponte");
    expect(Object.keys(ponte.doc.modos)).toEqual([NOVO]);
    expect(ponte.doc.eventosPendentes).toEqual([]);
  });

  it("por cliente: sai tudo dele, mesmo ativo", async () => {
    banco = await bancoDeTeste();
    await semear(banco);
    const plano = await planejarCliente(banco, NOVO);
    expect(plano).toEqual({ telefones: [NOVO], conversaIds: ["c-novo"], lacunas: 1, registrosPonte: 1 });
    await executarPlano(banco, plano, null);
    expect((await banco.query<{ telefone: string }>("SELECT telefone FROM agente.conversas")).map((r) => r.telefone)).toEqual([VELHO]);
  });

  it("prazo menor que 1 dia é recusado", async () => {
    banco = await bancoDeTeste();
    await expect(planejarPorIdade(banco, 0, AGORA)).rejects.toThrow(/pelo menos 1 dia/);
  });

  it("tirarTelefonesDoEstadoPonte conta o que saiu", () => {
    const e = { ...estadoVazio(), modos: { [VELHO]: "humano" as const }, entregasParciais: { [VELHO]: { ids: [], partes: [] } } };
    expect(tirarTelefonesDoEstadoPonte(e, [VELHO]).registros).toBe(2);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

Run: `npx vitest run tests/retencaoBanco.test.ts`
Expected: FAIL

- [ ] **Passo 3: `src/operacao/retencaoBanco.ts`**

```ts
import type { Banco, Executor } from "../db/banco.js";
import { phoneMatches } from "../agent/state.js";
import { estadoVazio, normalizarEstadoPonte, type EstadoPonte } from "../whatsapp/estadoPonte.js";

const DIA_MS = 86_400_000;

export interface PlanoBanco {
  telefones: string[];
  conversaIds: string[];
  lacunas: number;
  registrosPonte: number;
}

export function tirarTelefonesDoEstadoPonte(estado: EstadoPonte, telefones: string[]): { estado: EstadoPonte; registros: number } {
  const sai = (tel: string) => telefones.some((t) => phoneMatches(tel, t));
  const novo: EstadoPonte = structuredClone(estado);
  let registros = 0;
  for (const mapa of [novo.modos, novo.entregasParciais ?? {}] as Array<Record<string, unknown>>) {
    for (const tel of Object.keys(mapa)) {
      if (sai(tel)) {
        delete mapa[tel];
        registros++;
      }
    }
  }
  const antes = novo.eventosPendentes.length;
  novo.eventosPendentes = novo.eventosPendentes.filter((e) => !sai((e as { telefone?: string }).telefone ?? ""));
  registros += antes - novo.eventosPendentes.length;
  return { estado: novo, registros };
}

async function estadoPonte(banco: Executor): Promise<EstadoPonte> {
  const [linha] = await banco.query<{ doc: unknown }>("SELECT doc FROM agente.estado_ponte WHERE id = 1");
  if (!linha) return estadoVazio();
  try {
    return normalizarEstadoPonte(linha.doc);
  } catch {
    return estadoVazio();
  }
}

function limite(dias: number, agora: number): Date {
  if (!Number.isFinite(dias) || dias < 1) throw new Error("prazo de retenção precisa ser de pelo menos 1 dia");
  return new Date(agora - dias * DIA_MS);
}

async function montar(banco: Executor, linhas: Array<{ telefone: string; conversa_id: string | null }>, lacunas: number): Promise<PlanoBanco> {
  const telefones = linhas.map((l) => l.telefone);
  return {
    telefones,
    conversaIds: linhas.map((l) => l.conversa_id).filter((c): c is string => !!c),
    lacunas,
    registrosPonte: telefones.length ? tirarTelefonesDoEstadoPonte(await estadoPonte(banco), telefones).registros : 0,
  };
}

export async function planejarPorIdade(banco: Banco, dias: number, agora = Date.now()): Promise<PlanoBanco> {
  const corte = limite(dias, agora);
  const linhas = await banco.query<{ telefone: string; conversa_id: string | null }>(
    "SELECT telefone, doc->'estado'->>'conversaId' AS conversa_id FROM agente.conversas WHERE atualizado_em < $1 ORDER BY telefone",
    [corte]
  );
  const [{ n }] = await banco.query<{ n: number }>("SELECT count(*)::int AS n FROM agente.lacunas WHERE registrado_em < $1", [corte]);
  return montar(banco, linhas, n);
}

export async function planejarCliente(banco: Banco, telefone: string): Promise<PlanoBanco> {
  if (!/^\d{10,15}$/.test(telefone)) throw new Error("telefone só com dígitos, com DDI");
  const linhas = await banco.query<{ telefone: string; conversa_id: string | null }>(
    "SELECT telefone, doc->'estado'->>'conversaId' AS conversa_id FROM agente.conversas WHERE telefone = $1",
    [telefone]
  );
  const ids = linhas.map((l) => l.conversa_id).filter((c): c is string => !!c);
  const [{ n }] = await banco.query<{ n: number }>("SELECT count(*)::int AS n FROM agente.lacunas WHERE conversa_id = ANY($1::text[])", [ids]);
  // O estado da ponte guarda o telefone mesmo sem conversa: o cliente sai de lá também.
  return { ...(await montar(banco, linhas, n)), telefones: [telefone], registrosPonte: tirarTelefonesDoEstadoPonte(await estadoPonte(banco), [telefone]).registros };
}

export async function telefonesAtivos(banco: Banco, dias: number, agora = Date.now()): Promise<Set<string>> {
  const linhas = await banco.query<{ telefone: string }>("SELECT telefone FROM agente.conversas WHERE atualizado_em >= $1", [limite(dias, agora)]);
  return new Set(linhas.map((l) => l.telefone));
}

/** Apaga de vez. Só o script chama, e só com --executar. porIdade null = pedido de um cliente. */
export async function executarPlano(banco: Banco, plano: PlanoBanco, porIdade: { dias: number; agora: number } | null): Promise<void> {
  await banco.transacao(async (tx) => {
    await tx.query("DELETE FROM agente.conversas WHERE telefone = ANY($1::text[])", [plano.telefones]);
    if (porIdade) await tx.query("DELETE FROM agente.lacunas WHERE registrado_em < $1", [limite(porIdade.dias, porIdade.agora)]);
    else await tx.query("DELETE FROM agente.lacunas WHERE conversa_id = ANY($1::text[])", [plano.conversaIds]);
    if (plano.registrosPonte > 0) {
      const { estado } = tirarTelefonesDoEstadoPonte(await estadoPonte(tx), plano.telefones);
      await tx.query("UPDATE agente.estado_ponte SET doc = $1::jsonb, atualizado_em = now() WHERE id = 1", [JSON.stringify(estado)]);
    }
  });
}
```

Confira em `src/agent/state.ts` que `phoneMatches` aceita `(a: string, b: string)`; é o mesmo que a `retencao.ts` usa hoje.

- [ ] **Passo 4: `src/operacao/retencao.ts` fica só com arquivos**

- `PastasRetencao` = `{ artes: string; logs: string }`.
- `AlvoRetencao.tipo` = `"artes" | "log"`; somem `registros` e `conteudoNovo`.
- `selecionarParaLimpeza(pastas, dias, agora = Date.now(), conversasVivas: Set<string> = new Set())`: apague o bloco das conversas (o laço em `pastas.conversas`), use o `conversasVivas` recebido no bloco das artes e apague o `alvos.push(...filtrar*)` do fim.
- `selecionarCliente(pastas, telefone, conversaId: string | undefined, agora = Date.now())`: apague a leitura do arquivo da conversa (o `conversaId` vem do banco) e o `alvos.push(...filtrar*)` do fim.
- Apague `filtrarOrcamentosTeste`, `filtrarLacunas`, `filtrarPonte`, `alvoDeRegistros` e o ramo `registros` do `apagar`.
- O comentário do topo passa a dizer que conversas, lacunas e estado da ponte estão em `retencaoBanco.ts`.

Os testes de `retencao.ts` que cobriam conversas, lacunas, orçamentos e ponte em arquivo saem (o `retencaoBanco.test.ts` cobre). Os de artes e logs ficam, passando o `conversasVivas`.

- [ ] **Passo 5: `scripts/limparDados.ts`**

Mantenha o cabeçalho de uso e as flags. O corpo passa a ser:

```ts
const banco = await abrirBanco();
const pastas: PastasRetencao = { artes: config.whatsapp.artesDir, logs: join(process.cwd(), "logs") };
const agora = Date.now();
const plano = telefone ? await planejarCliente(banco, telefone) : await planejarPorIdade(banco, dias, agora);
const alvos = telefone
  ? selecionarCliente(pastas, telefone, plano.conversaIds[0], agora)
  : selecionarParaLimpeza(pastas, dias, agora, await telefonesAtivos(banco, dias, agora));
```

Na impressão, antes do laço de artes/logs:

```ts
console.log(`conversa  ${String(plano.telefones.length).padStart(5)} no banco`);
for (const t of plano.telefones.slice(0, 20)) console.log(`   ${t}`);
console.log(`lacunas   ${String(plano.lacunas).padStart(5)} no banco`);
console.log(`ponte     ${String(plano.registrosPonte).padStart(5)} registro(s) no banco`);
```

e o laço de tipos fica só com `["artes", "log"]`. A condição "nada a fazer" passa a ser `alvos.length === 0 && plano.telefones.length === 0 && plano.lacunas === 0`. Com `--executar`:

```ts
await executarPlano(banco, plano, telefone ? null : { dias, agora });
console.log(`\nBanco limpo; ${apagar(alvos)} arquivo(s) apagado(s).`);
```

e `await banco.fechar()` no fim. Troque a frase "Rode com o agente e a ponte parados..." por: "Rode com o agente e a ponte parados: uma conversa apagada com o agente no ar volta da memória na próxima gravação." (o motivo continua o mesmo).

- [ ] **Passo 6: conferir a simulação contra o Docker**

```bash
npm run limpar:dados
```

Expected: imprime as contagens (zero), "Nada passou do prazo.", e não apaga nada.

- [ ] **Passo 7: tudo verde e commit**

Run: `npm run typecheck` e `npx vitest run`
Expected: limpo e verde.

```bash
git add -A src/operacao scripts/limparDados.ts tests
git commit -m "feat(banco): retenção das conversas, lacunas e ponte no Postgres"
```

---

### Tarefa 7: catálogo, tipos e vetores no banco (sem ligar na busca)

**Arquivos:**
- Criar: `db/migrations/002_catalogo.sql`, `src/catalogo/indicePg.ts`, `tests/indicePg.test.ts`

**Interfaces:**
- Consome: `Banco`, `bancoDeTeste`, os tipos `IndiceCatalogo`, `ProdutoIndexado`, `VERSAO_INDICE`, `indiceVazio` de `src/catalogo/indice.ts` (sem mudar `indice.ts` nesta tarefa)
- Produz: `class PgProductIndexStore` com `carregar(): Promise<IndiceCatalogo>` e `salvar(i: IndiceCatalogo): Promise<void>`, e `sincronizadoEm(): Promise<string>` (a releitura de 5 min da Tarefa 9 usa). Ela **não** declara `implements ProductIndexStore` ainda: a interface só vira assíncrona na Tarefa 9.

- [ ] **Passo 1: `db/migrations/002_catalogo.sql`**

```sql
CREATE TABLE IF NOT EXISTS agente.produtos (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agente.catalogo_estado (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  versao INT NOT NULL,
  sincronizado_em TEXT NOT NULL,
  completo BOOLEAN NOT NULL
);

-- Da busca semântica (Gui): ligadas na Tarefa 10, quando a busca-semantica voltar.
CREATE TABLE IF NOT EXISTS agente.tipos_produto (
  produto_id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agente.vetores_produto (
  produto_id TEXT PRIMARY KEY,
  vetor vector(1536) NOT NULL,
  modelo TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agente.vetores_tipo (
  tipo TEXT PRIMARY KEY,
  vetor vector(1536) NOT NULL,
  modelo TEXT NOT NULL
);
```

(Sem índice vetorial: a busca carrega os vetores para memória e calcula o produto escalar lá, como a spec do Gui define; 6,5 mil linhas não pedem índice.)

- [ ] **Passo 2: o teste que falha** (`tests/indicePg.test.ts`)

```ts
import { describe, it, expect, afterEach } from "vitest";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";
import { PgProductIndexStore } from "../src/catalogo/indicePg.js";
import { indiceVazio, VERSAO_INDICE, type ProdutoIndexado } from "../src/catalogo/indice.js";

const produto = (id: string, nome: string): ProdutoIndexado => ({
  id, slug: id, codigo: id, sku: id, nome, descricao: "", categorias: ["Canecas"], destaque: false,
  quantidade_minima: 10, imagem_url: null, personalizacoes: [],
  subprodutos: [{ id: `${id}-s`, sku: `${id}-s`, cor: "Branca", estoque: 100, faixas: [{ min: 10, max: 99, preco: 42.41 }] }],
  etiquetas_embutidas: [], atualizado_em: "2026-11-01", sincronizado_em: "2026-11-10T00:00:00.000Z", ausencias: 0,
});

describe("PgProductIndexStore", () => {
  let banco: Banco | undefined;
  afterEach(async () => {
    await banco?.fechar();
    banco = undefined;
  });

  it("vazio → índice vazio", async () => {
    banco = await bancoDeTeste();
    expect(await new PgProductIndexStore(banco).carregar()).toEqual(indiceVazio());
  });

  it("salva e relê o índice inteiro, com os preços", async () => {
    banco = await bancoDeTeste();
    const s = new PgProductIndexStore(banco);
    const indice = { versao: VERSAO_INDICE, sincronizado_em: "2026-11-10T00:00:00.000Z", completo: true, produtos: [produto("a", "Caneca"), produto("b", "Squeeze")] };
    await s.salvar(indice);
    expect(await s.carregar()).toEqual(indice);
    expect(await s.sincronizadoEm()).toBe("2026-11-10T00:00:00.000Z");
  });

  it("salvar tira quem não está mais no índice", async () => {
    banco = await bancoDeTeste();
    const s = new PgProductIndexStore(banco);
    await s.salvar({ versao: VERSAO_INDICE, sincronizado_em: "t1", completo: true, produtos: [produto("a", "A"), produto("b", "B")] });
    await s.salvar({ versao: VERSAO_INDICE, sincronizado_em: "t2", completo: true, produtos: [produto("b", "B2")] });
    expect((await s.carregar()).produtos.map((p) => p.nome)).toEqual(["B2"]);
  });

  it("aguenta o tamanho do catálogo real", async () => {
    banco = await bancoDeTeste();
    const s = new PgProductIndexStore(banco);
    const produtos = Array.from({ length: 7000 }, (_, i) => produto(`p${String(i).padStart(5, "0")}`, `Produto ${i}`));
    await s.salvar({ versao: VERSAO_INDICE, sincronizado_em: "t", completo: true, produtos });
    expect((await s.carregar()).produtos).toHaveLength(7000);
  }, 60_000);

  it("versão diferente no banco → índice vazio (o próximo sync reescreve)", async () => {
    banco = await bancoDeTeste();
    await banco.query("INSERT INTO agente.catalogo_estado (id, versao, sincronizado_em, completo) VALUES (1, 1, 't', true)");
    expect(await new PgProductIndexStore(banco).carregar()).toEqual(indiceVazio());
  });
});
```

- [ ] **Passo 3: rodar e ver falhar**

Run: `npx vitest run tests/indicePg.test.ts`
Expected: FAIL

- [ ] **Passo 4: `src/catalogo/indicePg.ts`**

```ts
import type { Banco } from "../db/banco.js";
import { indiceVazio, VERSAO_INDICE, type IndiceCatalogo, type ProdutoIndexado } from "./indice.js";

const LOTE = 500;

/** Catálogo no banco. A busca não lê daqui a cada pergunta: carrega na partida e depois do sync. */
export class PgProductIndexStore {
  constructor(private readonly banco: Banco) {}

  async carregar(): Promise<IndiceCatalogo> {
    const [estado] = await this.banco.query<{ versao: number; sincronizado_em: string; completo: boolean }>(
      "SELECT versao, sincronizado_em, completo FROM agente.catalogo_estado WHERE id = 1"
    );
    if (!estado || estado.versao !== VERSAO_INDICE) return indiceVazio();
    const linhas = await this.banco.query<{ doc: ProdutoIndexado }>("SELECT doc FROM agente.produtos ORDER BY id");
    return { versao: estado.versao, sincronizado_em: estado.sincronizado_em, completo: estado.completo, produtos: linhas.map((l) => l.doc) };
  }

  async sincronizadoEm(): Promise<string> {
    const [estado] = await this.banco.query<{ sincronizado_em: string }>("SELECT sincronizado_em FROM agente.catalogo_estado WHERE id = 1");
    return estado?.sincronizado_em ?? "";
  }

  async salvar(indice: IndiceCatalogo): Promise<void> {
    await this.banco.transacao(async (tx) => {
      const ids = indice.produtos.map((p) => p.id);
      await tx.query("DELETE FROM agente.produtos WHERE NOT (id = ANY($1::text[]))", [ids]);
      for (let i = 0; i < indice.produtos.length; i += LOTE) {
        const lote = indice.produtos.slice(i, i + LOTE);
        await tx.query(
          `INSERT INTO agente.produtos (id, doc, atualizado_em)
           SELECT p->>'id', p, now() FROM jsonb_array_elements($1::jsonb) AS p
           ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, atualizado_em = now()`,
          [JSON.stringify(lote)]
        );
      }
      await tx.query(
        `INSERT INTO agente.catalogo_estado (id, versao, sincronizado_em, completo) VALUES (1, $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET versao = EXCLUDED.versao, sincronizado_em = EXCLUDED.sincronizado_em, completo = EXCLUDED.completo`,
        [indice.versao, indice.sincronizado_em, indice.completo]
      );
    });
  }
}
```

(O teste "salva e relê" compara com `toEqual` e o `ORDER BY id`; os ids do teste já vêm em ordem.)

- [ ] **Passo 5: rodar e ver passar**

Run: `npx vitest run tests/indicePg.test.ts tests/banco.test.ts`
Expected: PASS. No `banco.test.ts`, a lista de tabelas continua batendo (o `arrayContaining` aceita as novas).

- [ ] **Passo 6: commit**

```bash
git add db/migrations/002_catalogo.sql src/catalogo/indicePg.ts tests/indicePg.test.ts
git commit -m "feat(banco): catálogo, tipos e vetores no Postgres, ainda sem ligar na busca"
```

---

### Tarefa 8: fumaça contra o Docker e pedido ao Dudu

**Arquivos:**
- Criar: `scripts/fumacaBanco.ts`, `docs/pedido-ao-dudu-banco.md`
- Modificar: `package.json` (script `fumaca:banco`)

- [ ] **Passo 1: `scripts/fumacaBanco.ts`**

Ele exercita o critério 4 da spec sem WhatsApp: abre o banco duas vezes, simulando 2 reinícios, sobre o mesmo Docker.

```ts
import "dotenv/config";
import { abrirBanco } from "../src/db/banco.js";
import { PgConversas } from "../src/conversas/armazem.js";
import { RepositorioConversas } from "../src/conversas/repositorio.js";
import { PgEstadoPonte, estadoVazio } from "../src/whatsapp/estadoPonte.js";
import { PgModoLia } from "../src/whatsapp/modoLia.js";

const TEL = "5500000000000"; // número de fumaça, não é de cliente
const falhou = (m: string) => {
  console.error(`FALHOU: ${m}`);
  process.exit(1);
};

// 1º processo: grava conversa, estado da ponte e modo
let banco = await abrirBanco();
const repo = new RepositorioConversas(new PgConversas(banco));
const c = await repo.carregar(TEL);
c.estado.modo = "humano";
c.idsVistos.push("fumaca-1");
await repo.salvar(c);
await new PgEstadoPonte(banco).salvar({ ...estadoVazio(), modos: { [TEL]: "humano" }, eventosPendentes: [] });
await new PgModoLia(banco, { modo: "desligada", numerosTeste: [], atualizadoEm: null }).salvar({ modo: "teste", numerosTeste: [TEL] });
await banco.fechar();

// 2º processo: tudo volta
banco = await abrirBanco();
const relida = await new RepositorioConversas(new PgConversas(banco)).carregar(TEL);
if (relida.estado.modo !== "humano" || !relida.idsVistos.includes("fumaca-1")) falhou("conversa não voltou");
if ((await new PgEstadoPonte(banco).carregar()).modos[TEL] !== "humano") falhou("estado da ponte não voltou");
if ((await new PgModoLia(banco, { modo: "desligada", numerosTeste: [], atualizadoEm: null }).ler()).modo !== "teste") falhou("modo da Lia não voltou");

// limpa o que a fumaça criou
await banco.query("DELETE FROM agente.conversas WHERE telefone = $1", [TEL]);
await banco.query("DELETE FROM agente.estado_ponte");
await banco.query("DELETE FROM agente.modo_lia");
await banco.fechar();
console.log("Fumaça OK: conversa, estado da ponte e modo da Lia sobreviveram ao reinício.");
```

No `package.json`: `"fumaca:banco": "tsx scripts/fumacaBanco.ts"`.

Run: `npm run db:subir` e `npm run fumaca:banco`
Expected: `Fumaça OK: ...`

- [ ] **Passo 2: fumaça com os processos de verdade**

Com o Docker no ar e `BRINDEME_MODE=mock`:

1. `npm run agente` num terminal: deve subir sem erro e sem ler `data/conversas`. Em mock, o índice do catálogo continua vindo do arquivo de mock até a Tarefa 9.
2. `npm run chat` noutro terminal: mande "oi", e a conversa precisa aparecer em `SELECT telefone FROM agente.conversas`, conferido com `docker exec agente-banco psql -U agente -d agente -c "..."`.
3. Pare o agente (Ctrl+C), suba de novo, e a conversa continua de onde parou.

Se o `chat` não usa o `RepositorioConversas` (só o `runTurn`), o passo 2 confere pelo `npm run agente` + o contrato HTTP (`tests/contrato.test.ts` já cobre a ida e volta). Nesse caso, anote no commit que a fumaça manual da ponte com WhatsApp fica para a Tarefa 11.

- [ ] **Passo 3: `docs/pedido-ao-dudu-banco.md`**

```markdown
# Pedido ao Dudu: banco do agente no Neon

O agente passa a guardar o estado no mesmo Neon do CRM, num schema separado (`agente`) e com usuário próprio. O CRM não lê esse schema, e o agente não lê as tabelas do CRM.

1. No SQL Editor do Neon, como dono do banco, rode `db/papel-agente.sql` **trocando a senha** antes.
2. Mande ao João, por canal privado, a URL do usuário `agente`, no formato
   `postgres://agente:<senha>@<host>.neon.tech/<banco>?sslmode=require`.
3. O `sync:agente` do CRM (`crm/scripts/syncAgente.ts`) lê as conversas em arquivo do agente. Com o banco, esses arquivos deixam de existir. Como a ponte já manda as mensagens ao vivo para o CRM, o `sync:agente` pode sair, ou passar a ler outra fonte se você ainda precisar importar histórico. A decisão é sua.
```

- [ ] **Passo 4: commit**

```bash
git add scripts/fumacaBanco.ts package.json docs/pedido-ao-dudu-banco.md
git commit -m "docs(banco): fumaça contra o Docker e pedido ao Dudu"
```

**Aqui para a parte que não depende do Gui.** Pare e avise o João: o que foi feito, os testes, e que as Tarefas 9 a 12 esperam a `busca-semantica`.

---

## Pendências para quando a `busca-semantica` voltar

Estas tarefas dependem do código do Gui, então o plano diz **o quê** e **onde**, e o código exato é escrito depois de ler a branch dele. Antes de começar, leia a seção 9 da spec dele e confira se o `TipoStore`/`VectorStore` nasceram assíncronos, como combinado. Se não, ajuste-os primeiro, num commit separado.

### Tarefa 9: ligar o catálogo

- Merge da `busca-semantica` na `banco-neon`. Depois do merge, confira com `git apply --check --reverse` que nenhuma correção nossa foi desfeita. Foi o que aconteceu em 03/11.
- `ProductIndexStore` vira assíncrona (`carregar(): Promise<IndiceCatalogo>`, `salvar(): Promise<void>`). `PgProductIndexStore` passa a declarar `implements ProductIndexStore`. `MemoryProductIndexStore` ganha `async`. `FileProductIndexStore` e `arquivoIndicePadrao` saem.
- Os 12 chamadores: `src/api/index.ts:33`, `src/partida.ts:27,40`, `src/operacao/exigirAmbiente.ts:16`, `src/tools/buscarProdutos.ts:39`, `scripts/avaliarRecomendacao.ts:61`, `scripts/conferirPrecos.ts:46`, `scripts/syncCatalogo.ts:48`, `scripts/syncPrecos.ts:34` e o `sincronizarCatalogo` (`src/catalogo/indice.ts:296`). A busca passa a receber o índice já carregado, sem chamar `carregar()` por dentro. É o contrato da seção 9 da spec do Gui.
- Na API, guarde o índice numa variável do `main()`. O sync que roda dentro dela troca a referência quando termina. A cada 5 min, `PgProductIndexStore.sincronizadoEm()`: se mudou (por exemplo, `sync:precos` rodou por fora), recarrega e troca a referência.
- O intervalo do sync dentro da API sai de `SEIS_HORAS_MS` para `config.catalogo.intervaloMin` (env `CATALOGO_INTERVALO_MIN`, padrão 45).
- Em mock, o sync continua desligado (a regra de `src/api/index.ts:51`). O índice do mock vem dos fixtures para um `MemoryProductIndexStore`, sem gravar no banco, para os produtos de teste nunca entrarem no catálogo real.
- `ligarStores` liga também o catálogo.
- O `sync:precos -- --migrar` (v1 → v2, a partir do arquivo) sai, porque o banco nasce na v2.
- Tarefa no Agendador do Windows para o `npm run sync:precos` noturno. Comando em `docs/fase-6/manual-operacao.md`.

### Tarefa 10: `PgTipoStore` e `PgVectorStore`

- Implemente atrás das interfaces do Gui, sobre `agente.tipos_produto`, `agente.vetores_produto` e `agente.vetores_tipo` (Tarefa 7).
- O vetor vai e volta como texto `'[0.1,0.2,...]'` (formato do pgvector). Na leitura, converta para `Float32Array`. Teste de contrato contra a versão em arquivo dele: mesmos ids, mesmos valores com tolerância de 1e-6.
- As versões em arquivo dele (`data/tipos-produto.json`, `data/vetores-*.bin/json`) saem. O `tipos-corrigidos.json` fica no repo (spec, seção 3).

### Tarefa 11: verificação final

- `npm run typecheck`, `npx vitest run` e os evals (`npm run evals`, que usam mock e memória), comparados com a última rodada boa.
- Fumaça da Tarefa 8 de novo, e agora com a ponte e o WhatsApp: uma conversa pelo número de teste, a ponte e a API reiniciadas no meio, e a conversa, o modo e os eventos pendentes voltam.
- Conferir o critério 6 da spec: `grep -rn "AGENTE_DATABASE_URL\|connectionString" src scripts` não imprime a URL em lugar nenhum. Num erro de banco provocado (Docker parado), o log só traz `code` e `message`.

### Tarefa 12: apagar os arquivos de dados locais

**Ação irreversível. Mostre a lista e espere o OK do João antes de apagar.**

- Lista: `data/conversas/`, `data/ponte-estado.json`, `data/lia-modo.json`, `data/estado-sistema.json`, `data/lacunas.jsonl`, `data/orcamentos-teste.json`, `data/pedidos-index.json`, `data/produtos-index.json`, `data/produtos-index-mock.json` (se o mock passou a vir dos fixtures), e os arquivos de tipos e vetores do Gui.
- Ficam: `data/whatsapp-sessao/`, `data/artes/`, `logs/`.
- Só na máquina do João. A máquina do chip é com o dev de lá, que recebe a mesma lista.
- Confira que nenhum código ainda aponta para esses caminhos: `grep -rn "data/" src scripts`, só sessão e artes.

---

## Entrega

- Antes do push, junte os commits num `docs` (spec e plano), num `feat` e num `fix` (correções vão separadas), como na Fase 0.
- Push e PR só com o OK do João. O PR leva o `docs/pedido-ao-dudu-banco.md`.
