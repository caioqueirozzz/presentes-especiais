import "dotenv/config";
import { abrirBanco } from "../src/db/banco.js";

// abrirBanco já aplica as migrations pendentes; aqui só se mostra o que está registrado.
const banco = await abrirBanco();
try {
  const feitas = await banco.query<{ nome: string }>("SELECT nome FROM agente.schema_migrations ORDER BY nome");
  console.log(`Migrations em dia: ${feitas.map((m) => m.nome).join(", ")}`);
} finally {
  await banco.fechar();
}
