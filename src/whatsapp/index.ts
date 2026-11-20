import "dotenv/config";
import { config } from "../config.js";
import { MSG_SUSPENSO } from "../operacao/verificacaoAmbiente.js";
import { exigirAmbiente } from "../operacao/exigirAmbiente.js";
import { PgConversas } from "../conversas/armazem.js";
import { lerEstadoSistema, ligarEstadoSistema } from "../controle/estadoSistema.js";
import { abrirBanco } from "../db/banco.js";
import { criarClienteHttp } from "./agenteHttp.js";
import { iniciarControle } from "./controle.js";
import { ObservadorCrm } from "./crm.js";
import { PgEstadoPonte } from "./estadoPonte.js";
import { criarLogPonte } from "./log.js";
import { PgModoLia, configLiaPadrao } from "./modoLia.js";
import { Ponte } from "./ponte.js";
import { CanalWwebjs } from "./sessao.js";

async function main(): Promise<void> {
  exigirAmbiente("ponte");
  const banco = await abrirBanco();
  await ligarEstadoSistema(banco);
  if (lerEstadoSistema().suspenso) console.warn(`! estado-sistema: ${MSG_SUSPENSO}`);
  const w = config.whatsapp;
  const log = criarLogPonte();
  const crmLigado = Boolean(config.crm.url && config.crm.segredo.length >= 16);
  const canal = new CanalWwebjs({
    sessaoDir: w.sessaoDir,
    log,
    ...(w.chromePath ? { chromePath: w.chromePath } : {}),
    ...(w.parearTelefone ? { parearTelefone: w.parearTelefone } : {}),
    ...(w.versaoWeb ? { versaoWeb: w.versaoWeb } : {}),
  });
  const armazem = new PgEstadoPonte(banco, log);
  const estadoInicial = await armazem.carregar();
  const ponte = new Ponte(
    canal,
    criarClienteHttp(config.agente.url, w.agenteTimeoutMs),
    {
      artesDir: w.artesDir,
      liberados: w.liberados,
      lote: { silencioMs: w.loteSilencioMs, maxMs: w.loteMaxMs, maxMensagens: w.loteMaxMensagens },
      avisoInstabilidadeMs: w.avisoInstabilidadeMin * 60_000,
      enviosPorMinuto: w.enviosPorMinuto,
      armazem,
      estadoInicial,
      ...(crmLigado ? { observador: new ObservadorCrm(config.crm.url, config.crm.segredo, (t) => new PgConversas(banco).ler(t), log) } : {}),
    },
    log
  );
  const lia = new PgModoLia(banco, configLiaPadrao(w.liberados));
  const modo = await lia.ler();
  ponte.definirModoLia(modo);
  ponte.iniciar(w.varreduraMs);
  if (crmLigado) {
    iniciarControle({ porta: config.crm.controlePorta, segredo: config.crm.segredo, canal, ponte, lia, log });
    console.log(`Mensagens indo para o CRM em ${config.crm.url}`);
  } else {
    console.log("CRM não configurado (CRM_URL e CRM_INTEGRATION_SECRET no .env): sem painel web, QR só aqui no terminal.");
  }
  if (modo.modo === "teste") console.log(`Lia em modo teste: respondendo só a ${modo.numerosTeste.join(", ")}`);
  else if (modo.modo === "desligada") console.log("Lia desligada: as mensagens chegam ao CRM, mas ninguém é respondido pela IA.");
  const sair = () => {
    void ponte
      .salvarAgora()
      .finally(() => canal.encerrar())
      .finally(() => banco.fechar())
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", sair);
  process.once("SIGTERM", sair);
  await canal.iniciar();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
