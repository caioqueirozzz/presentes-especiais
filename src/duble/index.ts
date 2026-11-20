import "dotenv/config";
import { config } from "../config.js";
import type { Agente } from "../contrato/agente.js";
import { criarServidorAgente } from "../contrato/servidorHttp.js";
import { createBrindeMeClient } from "../integrations/brindeme/factory.js";
import { criarLLM } from "../llm/index.js";
import { abrirBanco, logarErroBanco } from "../db/banco.js";
import { ligarSemantica, ligarStores } from "../db/stores.js";
import { ligarEstadoSistema } from "../controle/estadoSistema.js";
import { exigirAmbiente } from "../operacao/exigirAmbiente.js";
import { avisarConhecimentoECatalogo } from "../partida.js";
import { AgenteDireto } from "./direto.js";
import { AgenteEco } from "./eco.js";

function lerModo(): string {
  const i = process.argv.indexOf("--modo");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "direto";
}

async function main(): Promise<void> {
  const modo = lerModo();
  let agente: Agente;
  if (modo === "eco") {
    agente = new AgenteEco();
  } else if (modo === "direto") {
    const banco = await abrirBanco();
    await ligarEstadoSistema(banco);
    const catalogo = ligarStores(banco);
    const client = createBrindeMeClient();
    console.log(`API da loja: ${config.brindeMe.mode}`);
    await avisarConhecimentoECatalogo(client, catalogo);
    exigirAmbiente("agente", process.env, (await catalogo.carregar()).produtos.length);
    await ligarSemantica(banco, catalogo);
    agente = new AgenteDireto(criarLLM(), client);
  } else {
    console.error(`--modo inválido: ${modo} (use eco ou direto)`);
    process.exit(1);
  }
  const servidor = criarServidorAgente(agente, (e) => console.error(JSON.stringify(e)));
  servidor.listen(config.agente.porta, "127.0.0.1", () => {
    console.log(`Dublê do agente (${modo}) em http://127.0.0.1:${config.agente.porta}`);
  });
}

main().catch((err) => {
  console.error("Falha:", logarErroBanco(err));
  process.exit(1);
});
