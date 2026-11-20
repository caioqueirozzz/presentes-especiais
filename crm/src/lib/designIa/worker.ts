import { query, transaction } from "@/lib/db";
import type { Executor } from "@/lib/db";
import { mudarEtapaTx, registrarEvento } from "@/lib/design";
import { armazem } from "@/lib/arquivos";
import { calcularPaleta } from "./paleta";
import { FalhaIa, gerarFicha, modeloIa } from "./ficha";

type JobDaFila = { id: string; lead_id: string; tentativa: number };
type Resultado = "ok" | "nova_tentativa" | "falhou" | "descartado";
type Deps = { fetchFn?: typeof fetch };

const ESPERA_SEGUNDOS = [30, 120]; // depois da 1ª e da 2ª falha
const MAX_TENTATIVAS = 3;

export async function pegarProximo(): Promise<JobDaFila | null> {
  return transaction(async (tx) => {
    const [job] = await tx.query<{ id: string; lead_id: string }>(
      `SELECT id, lead_id FROM design_jobs WHERE stage = 'PROCESSANDO_IA'
         AND (ia_proxima_tentativa_em IS NULL OR ia_proxima_tentativa_em <= NOW())
       ORDER BY prioridade = 'alta' DESC, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    if (!job) return null;
    const [r] = await tx.query<{ ia_tentativas: number }>("UPDATE design_jobs SET ia_tentativas = ia_tentativas + 1 WHERE id = $1 RETURNING ia_tentativas", [job.id]);
    return { id: job.id, lead_id: job.lead_id, tentativa: r.ia_tentativas };
  });
}

/**
 * Grava só se o job continua como foi pego: etapa PROCESSANDO_IA e a mesma tentativa. Imagem nova zera as
 * tentativas e cancelamento muda a etapa; nos dois casos o resultado calculado é descartado.
 */
async function comGuarda(job: JobDaFila, sets: string, params: unknown[], depois: (tx: Executor) => Promise<void>): Promise<boolean> {
  return transaction(async (tx) => {
    const linhas = await tx.query(
      `UPDATE design_jobs SET ${sets}, updated_at = NOW() WHERE id = $1 AND stage = 'PROCESSANDO_IA' AND ia_tentativas = $2 RETURNING id`,
      [job.id, job.tentativa, ...params]
    );
    if (!linhas.length) return false;
    await depois(tx);
    return true;
  });
}

/** Últimas 20 mensagens de texto depois do último job aprovado do lead: o pedido anterior não entra no briefing; cancelado não fecha pedido. */
async function conversaDoLead(leadId: string, jobId: string): Promise<string> {
  const msgs = await query<{ author: string; body: string }>(
    `SELECT author, body FROM messages WHERE lead_id = $1 AND kind = 'texto'
       AND sent_at > COALESCE((SELECT MAX(updated_at) FROM design_jobs
                               WHERE lead_id = $1 AND id <> $2 AND stage = 'APROVADO'), '-infinity')
     ORDER BY sent_at DESC LIMIT 20`,
    [leadId, jobId]
  );
  return msgs
    .reverse()
    .map((m) => `${m.author === "CLIENTE" ? "CLIENTE" : "LOJA"}: ${m.body}`)
    .join("\n");
}

export async function processarJob(job: JobDaFila, deps: Deps = {}): Promise<Resultado> {
  const inicio = Date.now();
  const log = (etapa: Resultado, extra: Record<string, unknown> = {}) => {
    console.log(JSON.stringify({ job: job.id, etapa, ms: Date.now() - inicio, ...extra }));
    return etapa;
  };

  try {
    const originais = await query<{ arquivo: string }>(
      `SELECT arquivo FROM design_assets WHERE job_id = $1 AND tipo = 'ORIGINAL' AND mime IN ('image/png','image/jpeg','image/webp')
       ORDER BY created_at DESC LIMIT 4`,
      [job.id]
    );
    if (!originais.length) {
      const gravou = await comGuarda(job, "ia_status = 'SEM_IMAGEM'", [], (tx) => mudarEtapaTx(tx, job.id, "NA_FILA", null));
      return log(gravou ? "ok" : "descartado", { sem_imagem: true });
    }

    const imagens = await Promise.all(originais.map((o) => armazem().ler(o.arquivo)));
    const r = await gerarFicha({ imagens, conversa: await conversaDoLead(job.lead_id, job.id), fetchFn: deps.fetchFn });
    const paleta = await calcularPaleta(imagens[0]);
    const ficha = { ...r.ficha, paleta, imagem_analisada: r.imagem_analisada };
    const tokens = { input_tokens: r.input_tokens, output_tokens: r.output_tokens };

    const gravou = await comGuarda(job, "ficha = $3::jsonb, briefing = $4, ia_status = 'OK'", [JSON.stringify(ficha), r.ficha.briefing], async (tx) => {
      await registrarEvento(tx, job.id, null, "ia_ok", { ...tokens, modelo: r.modelo, ms: Date.now() - inicio });
      await mudarEtapaTx(tx, job.id, "NA_FILA", null);
    });
    return log(gravou ? "ok" : "descartado", { tokens });
  } catch (err) {
    // Erro que não é FalhaIa (imagem corrompida, banco) conta como falha temporária
    const definitiva = err instanceof FalhaIa && err.definitiva;
    const motivo = (err as Error).message.slice(0, 120);
    if (definitiva) console.error(`\n*** design worker: falha definitiva da OpenAI (${motivo}). Confira a OPENAI_API_KEY. ***\n`);

    if (definitiva || job.tentativa >= MAX_TENTATIVAS) {
      const gravou = await comGuarda(job, "ia_status = 'FALHOU'", [], async (tx) => {
        await registrarEvento(tx, job.id, null, "ia_falhou", { motivo, modelo: modeloIa() });
        await mudarEtapaTx(tx, job.id, "NA_FILA", null);
      });
      return log(gravou ? "falhou" : "descartado", { erro: motivo });
    }
    const espera = ESPERA_SEGUNDOS[job.tentativa - 1];
    const gravou = await comGuarda(job, "ia_proxima_tentativa_em = NOW() + make_interval(secs => $3)", [espera], async () => {});
    return log(gravou ? "nova_tentativa" : "descartado", { erro: motivo });
  }
}

export async function rodarUmaVez(deps: Deps = {}): Promise<boolean> {
  const job = await pegarProximo();
  if (!job) return false;
  await processarJob(job, deps);
  return true;
}
