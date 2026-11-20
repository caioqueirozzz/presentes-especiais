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
