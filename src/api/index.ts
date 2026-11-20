import "dotenv/config";
import { config, conferirPrazos } from "../config.js";
import { criarServidorAgente } from "../contrato/servidorHttp.js";
import { PgConversas } from "../conversas/armazem.js";
import { lerEstadoSistema, ligarEstadoSistema } from "../controle/estadoSistema.js";
import { abrirBanco } from "../db/banco.js";
import { ligarSemantica, ligarStores } from "../db/stores.js";
import { RepositorioConversas } from "../conversas/repositorio.js";
import { sincronizarCatalogo } from "../catalogo/indice.js";
import { PgProductIndexStore } from "../catalogo/indicePg.js";
import { createBrindeMeClient } from "../integrations/brindeme/factory.js";
import { criarLLM } from "../llm/index.js";
import { MSG_SUSPENSO } from "../operacao/verificacaoAmbiente.js";
import { exigirAmbiente } from "../operacao/exigirAmbiente.js";
import { avisarConhecimentoECatalogo } from "../partida.js";
import { recarregarIndice } from "../tools/buscarProdutos.js";
import { AgenteDefinitivo } from "./agenteDefinitivo.js";

const CINCO_MIN_MS = 5 * 60_000;
const CONCORRENCIA_MAX_DO_SYNC = 2;

async function main(): Promise<void> {
  const banco = await abrirBanco();
  await ligarEstadoSistema(banco);
  const store = ligarStores(banco);
  exigirAmbiente("agente", process.env, (await store.carregar()).produtos.length);
  if (lerEstadoSistema().suspenso) console.warn(`! estado-sistema: ${MSG_SUSPENSO}`);
  const prazos = conferirPrazos(config.agente.tetoMs, config.whatsapp.agenteTimeoutMs);
  if (prazos) {
    console.error(prazos);
    process.exit(1);
  }
  let llm;
  try {
    llm = criarLLM();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const client = createBrindeMeClient();
  console.log(`API da loja: ${config.brindeMe.mode}`);
  await avisarConhecimentoECatalogo(client, store);
  await ligarSemantica(banco, store);

  if ((await store.carregar()).produtos.length === 0) {
    console.error("Índice do catálogo vazio: o agente não sobe sem ele. Rode antes: npm run sync:catalogo (a 1ª carga leva minutos).");
    process.exit(1);
  }

  // Cliente próprio: falhas do sync abrem o disjuntor dele, não o das conversas.
  const clienteDoSync = createBrindeMeClient({ reqPorMinuto: config.catalogo.reqPorMinuto });
  let gravacaoVista = store instanceof PgProductIndexStore ? await store.ultimaGravacao() : "";
  const sincronizar = () =>
    sincronizarCatalogo(clienteDoSync, store, {
      concorrencia: Math.min(config.catalogo.concorrencia, CONCORRENCIA_MAX_DO_SYNC),
      maxIdadeHoras: config.catalogo.maxIdadeHoras,
    })
      .then(async (r) => {
        console.log(`Catálogo sincronizado: ${r.ativos} ativos, ${r.novos} novos, ${r.removidos} removidos${r.completo ? "" : " (incompleto)"}`);
        await recarregarIndice();
        if (store instanceof PgProductIndexStore) gravacaoVista = await store.ultimaGravacao();
      })
      .catch((err) =>
        console.error(`Sync do catálogo falhou; o índice anterior continua valendo: ${err instanceof Error ? err.message : err}`)
      );
  // Só com a API real: em mock, o sync gravaria os produtos de teste dentro do índice real.
  if (config.brindeMe.mode === "http") {
    void sincronizar();
    setInterval(() => void sincronizar(), config.catalogo.intervaloMin * 60_000);
  }
  // Quem grava por fora (sync:precos noturno) não avisa a API: ela confere o banco a cada 5 min.
  if (store instanceof PgProductIndexStore) {
    setInterval(() => {
      void store
        .ultimaGravacao()
        .then(async (g) => {
          if (g === gravacaoVista) return;
          await recarregarIndice();
          gravacaoVista = g;
        })
        .catch((err) => console.error(`Releitura do catálogo falhou; o índice em uso continua: ${err instanceof Error ? err.message : err}`));
    }, CINCO_MIN_MS);
  }

  const log = (e: Record<string, unknown>) => console.error(JSON.stringify(e));
  const agente = new AgenteDefinitivo({
    repo: new RepositorioConversas(new PgConversas(banco), log),
    llm,
    client,
    tetoMs: config.agente.tetoMs,
    respostasPorHora: config.agente.respostasPorHora,
  });
  criarServidorAgente(agente, log).listen(config.agente.porta, "127.0.0.1", () => {
    console.log(`Agente em http://127.0.0.1:${config.agente.porta}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
