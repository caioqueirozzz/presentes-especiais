/**
 * Trava de partida (spec da Fase 0, seção 8): processo que atende confere o ambiente e sai com 1 se houver ERRO.
 * Produção é o padrão; só AMBIENTE=dev no .env relaxa mock, rascunho, índice vazio e CRM desligado para aviso.
 */
import { existsSync } from "fs";
import { join } from "path";
import { arquivoIndicePadrao, FileProductIndexStore } from "../catalogo/indice.js";
import { lerEstadoSistema } from "../controle/estadoSistema.js";
import { carregarBase } from "../knowledge/base.js";
import { verificarAmbiente, type FatosAmbiente } from "./verificacaoAmbiente.js";

export function levantarFatos(env: Record<string, string | undefined> = process.env): FatosAmbiente {
  const modo = env.BRINDEME_MODE === "http" ? "http" : "mock";
  let produtos = 0;
  try {
    produtos = new FileProductIndexStore(arquivoIndicePadrao(modo)).carregar().produtos.length;
  } catch {
    produtos = 0;
  }
  const sistema = lerEstadoSistema();
  return {
    temArquivoEnv: existsSync(join(process.cwd(), ".env")),
    produtosNoIndice: produtos,
    itensAprovados: carregarBase({ incluirRascunhos: false }).base.estatisticas().servidos,
    suspenso: sistema.suspenso,
    ferramentasDesligadasRuntime: sistema.ferramentasDesligadas ?? [],
  };
}

export const ehProducao = (env: Record<string, string | undefined> = process.env): boolean => (env.AMBIENTE ?? "").trim() !== "dev";

/** "ponte": só o que a ponte usa (o CRM); "agente": tudo. */
export function exigirAmbiente(escopo: "agente" | "ponte", env: Record<string, string | undefined> = process.env): void {
  const producao = ehProducao(env);
  const achados = verificarAmbiente(env, levantarFatos(env), { producao }).filter((a) => escopo === "agente" || a.item === "CRM");
  for (const a of achados.filter((x) => x.gravidade === "aviso")) console.warn(`! ${a.item}: ${a.mensagem}`);
  const erros = achados.filter((a) => a.gravidade === "erro");
  if (erros.length === 0) return;
  for (const a of erros) console.error(`ERRO ${a.item}: ${a.mensagem}`);
  console.error(`Ambiente de ${producao ? "produção" : "desenvolvimento"} com erro: corrija o .env (ou ponha AMBIENTE=dev para desenvolver) e rode npm run verificar:env.`);
  process.exit(1);
}
