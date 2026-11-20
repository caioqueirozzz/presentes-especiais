/**
 * Retenção de dados de cliente (issue #4, LGPD).
 *
 *   npm run limpar:dados                       # SIMULA: lista o que passou do prazo, não apaga nada
 *   npm run limpar:dados -- --dias 120         # outro prazo (padrão: RETENCAO_DIAS ou 90)
 *   npm run limpar:dados -- --executar         # APAGA de vez o que foi listado
 *   npm run limpar:dados -- --telefone 5583999990000 [--executar]   # tudo de um cliente que pediu exclusão
 *
 * Rode com o agente e a ponte parados: uma conversa apagada com o agente no ar volta da memória
 * na próxima gravação. O prazo é decisão da loja (issue #4); registre-o em docs/fase-6/manual-operacao.md.
 */
import "dotenv/config";
import { join } from "path";
import { config } from "../src/config.js";
import { abrirBanco } from "../src/db/banco.js";
import { apagar, selecionarCliente, selecionarParaLimpeza, type PastasRetencao } from "../src/operacao/retencao.js";
import { executarPlano, planejarCliente, planejarPorIdade, telefonesAtivos } from "../src/operacao/retencaoBanco.js";

const args = process.argv.slice(2);
const executar = args.includes("--executar");
const valor = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const dias = Number(valor("--dias") ?? process.env.RETENCAO_DIAS ?? 90);
const telefone = valor("--telefone")?.replace(/\D/g, "");

const banco = await abrirBanco();
try {
  const pastas: PastasRetencao = { artes: config.whatsapp.artesDir, logs: join(process.cwd(), "logs") };
  const agora = Date.now();
  const plano = telefone ? await planejarCliente(banco, telefone) : await planejarPorIdade(banco, dias, agora);
  const alvos = telefone
    ? selecionarCliente(pastas, telefone, plano.conversaIds[0], agora)
    : selecionarParaLimpeza(pastas, dias, agora, await telefonesAtivos(banco, dias, agora));

  const kb = (b: number) => (b === 0 ? "0 KB" : `${Math.max(1, Math.round(b / 1024))} KB`);
  const escopo = telefone ? `cliente ${telefone}` : `${dias} dia(s) sem atividade`;
  console.log(`\nRetenção: ${escopo} · ${executar ? "EXECUTANDO (apaga de vez)" : "simulação (nada é apagado)"}\n`);
  console.log(`conversa  ${String(plano.telefones.length).padStart(5)} no banco`);
  for (const t of plano.telefones.slice(0, 20)) console.log(`   ${t}`);
  console.log(`lacunas   ${String(plano.lacunas).padStart(5)} no banco`);
  console.log(`ponte     ${String(plano.registrosPonte).padStart(5)} registro(s) no banco`);
  for (const tipo of ["artes", "log"] as const) {
    const doTipo = alvos.filter((a) => a.tipo === tipo);
    const total = doTipo.reduce((s, a) => s + a.bytes, 0);
    console.log(`${tipo.padEnd(9)} ${String(doTipo.length).padStart(5)} item(ns) · ${kb(total)}`);
    for (const a of doTipo.slice(0, 20)) console.log(`   ${a.idadeDias}d  ${a.caminho}`);
    if (doTipo.length > 20) console.log(`   … e mais ${doTipo.length - 20}`);
  }

  const comando = telefone ? `--telefone ${telefone}` : `--dias ${dias}`;
  if (alvos.length === 0 && plano.telefones.length === 0 && plano.lacunas === 0 && plano.registrosPonte === 0) console.log(telefone ? "\nNada guardado desse telefone." : "\nNada passou do prazo.");
  else if (!executar) console.log(`\nSimulação. Para apagar: npm run limpar:dados -- ${comando} --executar`);
  else {
    await executarPlano(banco, plano, telefone ? null : { dias, agora });
    console.log(`\nBanco limpo; ${apagar(alvos)} arquivo(s) apagado(s).`);
  }
} finally {
  await banco.fechar();
}
