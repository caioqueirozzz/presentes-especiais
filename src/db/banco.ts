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

/** Serializa para coluna jsonb: o Postgres recusa \u0000 em texto jsonb (22P05). */
export const jsonb = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "string" ? x.replaceAll("\u0000", "") : x));

export function exigirSsl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Sem a causa: o TypeError traz a URL inteira, com a senha.
    throw new Error("AGENTE_DATABASE_URL inválida (caractere especial na senha precisa de percent-encoding).");
  }
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
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'agente') THEN CREATE SCHEMA agente; END IF; END $$; CREATE TABLE IF NOT EXISTS agente.schema_migrations (nome TEXT PRIMARY KEY, aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now())"
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
