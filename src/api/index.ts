import "dotenv/config";
import { config, conferirPrazos } from "../config.js";
import { criarServidorAgente } from "../contrato/servidorHttp.js";
import { PgConversas } from "../conversas/armazem.js";
import { lerEstadoSistema, ligarEstadoSistema } from "../controle/estadoSistema.js";
import { abrirBanco, logarErroBanco } from "../db/banco.js";
import { ligarSemantica, ligarStores } from "../db/stores.js";
import { RepositorioConversas } from "../conversas/repositorio.js";
import { criarCicloSync } from "../catalogo/cicloSync.js";
import { gerarTiposEVetores } from "../catalogo/geracao.js";
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
  // Em mock o índice só nasce no `avisarConhecimentoECatalogo`: contar antes dele daria "vazio" falso.
  const produtosNoIndice = (await store.carregar()).produtos.length;
  exigirAmbiente("agente", process.env, produtosNoIndice);
  const semantica = await ligarSemantica(banco, store);

  if (produtosNoIndice === 0) {
    console.error("Índice do catálogo vazio: o agente não sobe sem ele. Rode antes: npm run sync:catalogo (a 1ª carga leva minutos).");
    process.exit(1);
  }

  // Tudo em memória antes do 1º turno: do Neon longe, a carga leva mais que o teto do turno.
  const inicioCarga = Date.now();
  await Promise.all([recarregarIndice(), semantica?.tipos.carregar(), semantica?.vetoresProduto.carregar(), semantica?.vetoresTipo.carregar()]);
  console.log(`Catálogo e vetores em memória em ${Math.round((Date.now() - inicioCarga) / 1000)} s`);

  // Cliente próprio: falhas do sync abrem o disjuntor dele, não o das conversas.
  const clienteDoSync = createBrindeMeClient({ reqPorMinuto: config.catalogo.reqPorMinuto });
  const pg = store instanceof PgProductIndexStore ? store : null;
  const ciclo = criarCicloSync(
    {
      sincronizar: () =>
        sincronizarCatalogo(clienteDoSync, store, {
          concorrencia: Math.min(config.catalogo.concorrencia, CONCORRENCIA_MAX_DO_SYNC),
          maxIdadeHoras: config.catalogo.maxIdadeHoras,
        }),
      recarregar: recarregarIndice,
      assinatura: pg ? () => pg.ultimaGravacao() : undefined,
      gerar: semantica ? (indice) => gerarTiposEVetores(indice.produtos, semantica) : undefined,
      log: (l) => console.error(l),
    },
    pg ? await pg.ultimaGravacao() : ""
  );
  // Só com a API real: em mock, o sync gravaria os produtos de teste dentro do índice real.
  if (config.brindeMe.mode === "http") {
    void ciclo.executar();
    setInterval(() => void ciclo.executar(), config.catalogo.intervaloMin * 60_000);
  }
  if (pg) setInterval(() => void ciclo.conferirGravacaoExterna(), CINCO_MIN_MS);

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
  console.error("Falha:", logarErroBanco(err));
  process.exit(1);
});
