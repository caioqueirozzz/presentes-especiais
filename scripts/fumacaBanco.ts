import "dotenv/config";
import { abrirBanco, type Banco } from "../src/db/banco.js";
import { PgConversas } from "../src/conversas/armazem.js";
import { RepositorioConversas } from "../src/conversas/repositorio.js";
import { PgEstadoPonte, estadoVazio } from "../src/whatsapp/estadoPonte.js";
import { PgModoLia, type ConfigLia } from "../src/whatsapp/modoLia.js";

const TEL = "5500000000000"; // número de fumaça, não é de cliente
const PADRAO_LIA: ConfigLia = { modo: "desligada", numerosTeste: [], atualizadoEm: null };

// A limpeza apaga estado_ponte e modo_lia inteiros: em banco real isso destruiria estado de verdade.
let host = "";
try {
  host = new URL(process.env.AGENTE_DATABASE_URL ?? "").hostname;
} catch {
  /* URL ausente ou inválida cai na recusa abaixo */
}
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`Recusado: a fumaça só roda contra o Postgres local (host "${host || "inválido"}"). Ela apaga estado_ponte e modo_lia.`);
  process.exit(1);
}

const confere = (ok: boolean, m: string) => {
  if (!ok) throw new Error(m);
};

let banco: Banco | undefined;
try {
  // 1º processo: grava conversa, estado da ponte e modo
  banco = await abrirBanco();
  const c = await new RepositorioConversas(new PgConversas(banco)).carregar(TEL);
  c.estado.modo = "humano";
  c.idsVistos.push("fumaca-1");
  await new RepositorioConversas(new PgConversas(banco)).salvar(c);
  await new PgEstadoPonte(banco).salvar({ ...estadoVazio(), modos: { [TEL]: "humano" }, eventosPendentes: [] });
  await new PgModoLia(banco, PADRAO_LIA).salvar({ modo: "teste", numerosTeste: [TEL] });
  await banco.fechar();
  banco = undefined; // se o 2º abrirBanco falhar, a limpeza abre uma conexão nova

  // 2º processo: tudo volta
  banco = await abrirBanco();
  const relida = await new RepositorioConversas(new PgConversas(banco)).carregar(TEL);
  confere(relida.estado.modo === "humano" && relida.idsVistos.includes("fumaca-1"), "conversa não voltou");
  confere((await new PgEstadoPonte(banco).carregar()).modos[TEL] === "humano", "estado da ponte não voltou");
  confere((await new PgModoLia(banco, PADRAO_LIA).ler()).modo === "teste", "modo da Lia não voltou");
  console.log("Fumaça OK: conversa, estado da ponte e modo da Lia sobreviveram ao reinício.");
} catch (err) {
  console.error(`FALHOU: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  try {
    banco ??= await abrirBanco();
    await banco.query("DELETE FROM agente.conversas WHERE telefone = $1", [TEL]);
    await banco.query("DELETE FROM agente.estado_ponte");
    await banco.query("DELETE FROM agente.modo_lia");
    await banco.fechar();
  } catch (err) {
    console.error(`Limpeza falhou: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
