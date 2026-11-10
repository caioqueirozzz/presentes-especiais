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

  it("o schema agente existe e o bootstrap roda sem CREATE no database", async () => {
    banco = await bancoDeTeste();
    expect(await banco.query("SELECT 1 FROM pg_namespace WHERE nspname = 'agente'")).toHaveLength(1);
    await banco.executar("CREATE ROLE sem_create; GRANT USAGE, CREATE ON SCHEMA agente TO sem_create; GRANT ALL ON ALL TABLES IN SCHEMA agente TO sem_create; REVOKE CREATE ON DATABASE postgres FROM PUBLIC; SET ROLE sem_create");
    expect(await aplicarMigrations(banco)).toEqual([]);
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
