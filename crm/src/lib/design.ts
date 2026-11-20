import { createHash, randomUUID } from "node:crypto";
import { one, query, transaction } from "@/lib/db";
import type { Role } from "@/lib/types";
import type { Executor } from "@/lib/db";
import { logEvent, notify } from "@/lib/leads";
import { callPonte } from "@/lib/whatsapp";
import { EXTENSAO, LIMITE_BYTES, MIME, armazem, detectarTipo, ehAnalisavel, urlAbsoluta } from "@/lib/arquivos";
import type { TipoArquivo } from "@/lib/arquivos";

/*
 * Regras do Módulo Design. Toda escrita em design_* passa por aqui ou pelo worker da IA
 * (designIa/worker.ts, só os campos ia_*, ficha e briefing). Quem chama já conferiu a permissão.
 */

export type Etapa = "RECEBIDO" | "PROCESSANDO_IA" | "NA_FILA" | "EM_CRIACAO" | "AGUARDANDO_CLIENTE" | "AJUSTES" | "APROVADO" | "CANCELADO";
export type Origem = "LIA" | "VENDEDOR" | "PEDIDO";
export const ETAPAS_ABERTAS: Etapa[] = ["RECEBIDO", "PROCESSANDO_IA", "NA_FILA", "EM_CRIACAO", "AGUARDANDO_CLIENTE", "AJUSTES"];
/** O que a rota /etapa aceita; as outras etapas têm fluxo próprio. */
export const ETAPAS_MANUAIS: Etapa[] = ["PROCESSANDO_IA", "EM_CRIACAO", "AJUSTES", "CANCELADO"];
const NAO_ASSUMIDAS: Etapa[] = ["RECEBIDO", "PROCESSANDO_IA", "NA_FILA"];

export class DesignError extends Error {
  constructor(
    message: string,
    public status = 409
  ) {
    super(message);
  }
}

const TRANSICOES: Record<Etapa, Etapa[]> = {
  RECEBIDO: ["PROCESSANDO_IA", "NA_FILA"],
  PROCESSANDO_IA: ["NA_FILA"],
  NA_FILA: ["PROCESSANDO_IA", "EM_CRIACAO"],
  EM_CRIACAO: ["AGUARDANDO_CLIENTE"],
  AJUSTES: ["AGUARDANDO_CLIENTE"],
  AGUARDANDO_CLIENTE: ["AJUSTES", "APROVADO"],
  APROVADO: [],
  CANCELADO: [],
};

export const podeTransitar = (de: Etapa, para: Etapa) =>
  TRANSICOES[de].includes(para) || (para === "CANCELADO" && ETAPAS_ABERTAS.includes(de));

export async function registrarEvento(tx: Executor, jobId: string, atorId: string | null, tipo: string, dados: Record<string, unknown> = {}) {
  await tx.query("INSERT INTO design_events (job_id, actor_id, tipo, dados) VALUES ($1, $2, $3, $4)", [jobId, atorId, tipo, JSON.stringify(dados)]);
}

type ImagemValida = { bytes: Buffer; nome: string; recebidoEm?: string; tipo: TipoArquivo; sha256: string };

/** Arquivo vazio, grande demais ou de tipo não aceito é pulado (e registrado): um arquivo ruim não derruba o lote. */
function validarImagens(imagens: { bytes: Buffer; nome: string; recebidoEm?: string }[]): { validas: ImagemValida[]; ignorados: string[] } {
  const validas: ImagemValida[] = [];
  const ignorados: string[] = [];
  for (const i of imagens) {
    const tipo = i.bytes.length > 0 && i.bytes.length <= LIMITE_BYTES ? detectarTipo(i.bytes) : null;
    if (tipo) validas.push({ ...i, tipo, sha256: createHash("sha256").update(i.bytes).digest("hex") });
    else ignorados.push(i.nome);
  }
  return { validas, ignorados };
}

export async function salvarAsset(
  tx: Executor,
  jobId: string,
  tipoAsset: string,
  img: { bytes: Buffer; nome?: string; tipo: TipoArquivo; sha256?: string },
  versao = 1
): Promise<string> {
  const chave = `design/${jobId}/${tipoAsset.toLowerCase().replace("_", "-")}-${randomUUID()}.${EXTENSAO[img.tipo]}`;
  // shortcut: o arquivo é gravado antes do COMMIT; um rollback raro deixa o arquivo órfão no armazém, sem linha
  await armazem().salvar(chave, img.bytes, MIME[img.tipo]);
  await tx.query("INSERT INTO design_assets (job_id, tipo, arquivo, mime, bytes, meta, versao) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
    jobId,
    tipoAsset,
    chave,
    MIME[img.tipo],
    img.bytes.length,
    JSON.stringify({ ...(img.nome ? { nome: img.nome } : {}), ...(img.sha256 ? { sha256: img.sha256 } : {}) }),
    versao,
  ]);
  return chave;
}

export type JobRow = { id: string; lead_id: string; stage: Etapa; designer_id: string | null; conversa_com_designer: boolean };
const JOB_COLS = "id, lead_id, stage, designer_id, conversa_com_designer";

export async function abrirOuAnexar(p: {
  leadId: string;
  origem: Origem;
  requestedBy?: string | null;
  orderId?: string | null;
  motivo?: string;
  observacao?: string;
  prioridade?: "normal" | "alta";
  imagens: { bytes: Buffer; nome: string; recebidoEm?: string }[];
}): Promise<{ jobId: string; criado: boolean; ignorados?: string[] }> {
  const { validas, ignorados } = validarImagens(p.imagens);
  const ator = p.requestedBy ?? null;

  const tentar = () =>
    transaction(async (tx) => {
      let [job] = await tx.query<JobRow>(
        `SELECT ${JOB_COLS} FROM design_jobs WHERE lead_id = $1 AND stage NOT IN ('APROVADO','CANCELADO') FOR UPDATE`,
        [p.leadId]
      );
      const criado = !job;
      if (!job) {
        const [lead] = await tx.query<{ agent_mode: string }>("SELECT agent_mode FROM leads WHERE id = $1", [p.leadId]);
        if (!lead) throw new DesignError("Lead não encontrado.", 404);
        [job] = await tx.query<JobRow>(
          `INSERT INTO design_jobs (lead_id, order_id, requested_by, origem, prioridade) VALUES ($1, $2, $3, $4, $5) RETURNING ${JOB_COLS}`,
          [p.leadId, p.orderId ?? null, ator, p.origem, p.prioridade ?? "normal"]
        );
        await registrarEvento(tx, job.id, ator, "criado", { origem: p.origem, modo_anterior: lead.agent_mode });
      } else if (p.orderId) {
        await tx.query("UPDATE design_jobs SET order_id = COALESCE(order_id, $2) WHERE id = $1", [job.id, p.orderId]);
      }

      // O agente reenvia todos os arquivos da conversa: o que o job já tem (mesmo conteúdo) não entra de novo
      const jaTem = new Set(
        (await tx.query<{ sha256: string | null }>("SELECT meta->>'sha256' AS sha256 FROM design_assets WHERE job_id = $1 AND tipo = 'ORIGINAL'", [job.id])).map(
          (r) => r.sha256
        )
      );
      // O que é do pedido anterior fica de fora, com o mesmo corte do briefing (D14): chegou depois do último job aprovado.
      // Job cancelado não fecha pedido: cancelar e reabrir mantém os arquivos (teste de 19/11)
      const [{ corte }] = await tx.query<{ corte: Date | null }>(
        "SELECT MAX(updated_at) AS corte FROM design_jobs WHERE lead_id = $1 AND id <> $2 AND stage = 'APROVADO'",
        [p.leadId, job.id]
      );
      // Arquivo sem data (estado gravado antes dela existir): fora se já esteve num job aprovado do lead
      const deJobAnterior = new Set(
        (
          await tx.query<{ sha256: string | null }>(
            `SELECT a.meta->>'sha256' AS sha256 FROM design_assets a JOIN design_jobs j ON j.id = a.job_id
             WHERE j.lead_id = $1 AND j.id <> $2 AND j.stage = 'APROVADO' AND a.tipo = 'ORIGINAL'`,
            [p.leadId, job.id]
          )
        ).map((r) => r.sha256)
      );
      const doPedido = (img: ImagemValida) => {
        const em = Date.parse(img.recebidoEm ?? "");
        return Number.isNaN(em) ? !deJobAnterior.has(img.sha256) : !corte || em > corte.getTime();
      };
      const imagens = validas.filter((img) => doPedido(img) && !jaTem.has(img.sha256) && jaTem.add(img.sha256));
      const analisavel = imagens.some((i) => ehAnalisavel(i.tipo));
      for (const img of imagens) {
        await salvarAsset(tx, job.id, "ORIGINAL", img);
        await registrarEvento(tx, job.id, ator, "imagem_anexada", { nome: img.nome, tipo: img.tipo });
      }
      for (const nome of ignorados) await registrarEvento(tx, job.id, ator, "arquivo_ignorado", { nome: nome.slice(0, 200) });
      const nota = [p.motivo, p.observacao].filter(Boolean).join(": ");
      if (nota) {
        await tx.query("UPDATE design_jobs SET briefing = CASE WHEN briefing IS NULL THEN $2 ELSE briefing || chr(10) || $2 END WHERE id = $1", [
          job.id,
          nota,
        ]);
      }

      if (criado) {
        if (analisavel) {
          await mudarEtapaTx(tx, job.id, "PROCESSANDO_IA", null);
        } else {
          await tx.query("UPDATE design_jobs SET ia_status = 'SEM_IMAGEM' WHERE id = $1", [job.id]);
          await mudarEtapaTx(tx, job.id, "NA_FILA", null);
        }
      } else if (analisavel && NAO_ASSUMIDAS.includes(job.stage)) {
        if (job.stage === "PROCESSANDO_IA") {
          // Zerar as tentativas também faz o worker descartar o resultado que estiver calculando com as imagens antigas
          await tx.query("UPDATE design_jobs SET ia_tentativas = 0, ia_status = 'PENDENTE', ia_proxima_tentativa_em = NULL, updated_at = NOW() WHERE id = $1", [job.id]);
        } else {
          await mudarEtapaTx(tx, job.id, "PROCESSANDO_IA", null);
        }
      } else if (imagens.length && job.designer_id) {
        await notify(tx, job.designer_id, "Cliente mandou imagem nova", "Chegou arquivo novo num job seu.", `/app/design/${job.id}`);
      }
      return { jobId: job.id, criado, ...(ignorados.length ? { ignorados } : {}) };
    });

  try {
    return await tentar();
  } catch (err) {
    // Dois gatilhos ao mesmo tempo: o índice único barrou o segundo, que agora acha o job do primeiro
    if ((err as { code?: string }).code === "23505") return tentar();
    throw err;
  }
}

/** Muda a etapa sem a trava das etapas de fluxo próprio. Uso interno do módulo e do worker. */
export async function mudarEtapaTx(tx: Executor, jobId: string, para: Etapa, atorId: string | null, dados: Record<string, unknown> = {}) {
  const [job] = await tx.query<JobRow>(`SELECT ${JOB_COLS} FROM design_jobs WHERE id = $1 FOR UPDATE`, [jobId]);
  if (!job) throw new DesignError("Job não encontrado.", 404);
  if (!podeTransitar(job.stage, para)) throw new DesignError(`Não dá para ir de ${job.stage} para ${para}.`);
  const extra =
    para === "PROCESSANDO_IA"
      ? ", ia_tentativas = 0, ia_status = 'PENDENTE', ia_proxima_tentativa_em = NULL"
      : para === "AJUSTES" || para === "AGUARDANDO_CLIENTE"
        ? ", confirmacao_pedida_em = NULL, confirmacao_versao = NULL"
        : "";
  await tx.query(`UPDATE design_jobs SET stage = $2, updated_at = NOW()${extra} WHERE id = $1`, [jobId, para]);
  await registrarEvento(tx, jobId, atorId, "etapa", { de: job.stage, para, ...dados });
  if (para === "NA_FILA" && !job.designer_id) await atribuirDesignerTx(tx, jobId);
}

export async function mudarEtapa(jobId: string, para: Etapa, atorId: string | null, dados?: Record<string, unknown>) {
  if (para === "APROVADO" || para === "AGUARDANDO_CLIENTE") throw new DesignError("Esta etapa tem fluxo próprio.");
  if (para === "CANCELADO") return cancelar(jobId, atorId);
  await transaction((tx) => mudarEtapaTx(tx, jobId, para, atorId, dados));
}

async function cancelar(jobId: string, atorId: string | null) {
  const antes = await one<{ conversa_com_designer: boolean }>("SELECT conversa_com_designer FROM design_jobs WHERE id = $1", [jobId]);
  await transaction(async (tx) => {
    await mudarEtapaTx(tx, jobId, "CANCELADO", atorId);
    await registrarEvento(tx, jobId, atorId, "cancelado");
  });
  if (antes?.conversa_com_designer) await devolverAoAtendimento(jobId, atorId);
}

/** Rodízio entre os DESIGNER ativos, no molde de autoAssignLead. Sem designer, avisa os admins. */
export async function atribuirDesignerTx(tx: Executor, jobId: string): Promise<string | null> {
  const [settings] = await tx.query<{ last_designer_id: string | null }>("SELECT last_designer_id FROM crm_settings WHERE id FOR UPDATE");
  const [info] = await tx.query<{ nome: string; designer_id: string | null }>(
    "SELECT COALESCE(l.name, 'cliente') AS nome, j.designer_id FROM design_jobs j JOIN leads l ON l.id = j.lead_id WHERE j.id = $1",
    [jobId]
  );
  if (!info) throw new DesignError("Job não encontrado.", 404);
  if (info.designer_id) return info.designer_id;

  const designers = await tx.query<{ id: string }>("SELECT id FROM users WHERE role = 'DESIGNER' AND is_active ORDER BY created_at, id");
  if (designers.length === 0) {
    const admins = await tx.query<{ id: string }>("SELECT id FROM users WHERE role = 'ADMIN' AND is_active");
    for (const a of admins) {
      await notify(tx, a.id, "Job de design sem designer", `Novo job de ${info.nome}: não há designer ativo para receber.`, `/admin/design/${jobId}`);
    }
    return null;
  }
  const last = designers.findIndex((d) => d.id === settings?.last_designer_id);
  const next = designers[(last + 1) % designers.length].id;
  await tx.query("UPDATE crm_settings SET last_designer_id = $1, updated_at = NOW() WHERE id", [next]);
  await tx.query("UPDATE design_jobs SET designer_id = $2, updated_at = NOW() WHERE id = $1", [jobId, next]);
  await registrarEvento(tx, jobId, null, "atribuido", { designer_id: next });
  await notify(tx, next, "Novo job de design", `Novo job de design: ${info.nome}`, `/app/design/${jobId}`);
  return next;
}

export const atribuirDesigner = (jobId: string) => transaction((tx) => atribuirDesignerTx(tx, jobId));

/* ------------------------------------------------------------------ */
/*  Mockup, envio ao cliente e dupla confirmação                       */
/* ------------------------------------------------------------------ */

export const LEGENDA_CONFIRMACAO = (versao: number) =>
  `Para confirmar: esta é a arte final (versão ${versao}) que vai para produção. Depois de confirmada, ela não muda mais. Se estiver tudo certo, responda *APROVO*.`;

/** Só "aprovo", sem acento, pontuação ou caixa, aprova. Nenhum LLM decide isso. */
export function ehAprovacao(texto: string): boolean {
  const n = texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return n === "aprovo";
}

export async function anexarMockup(jobId: string, arquivo: { bytes: Buffer; nome: string }, atorId: string): Promise<{ versao: number }> {
  const tipo = detectarTipo(arquivo.bytes);
  // Vai ao cliente como foto: PDF ou SVG pelo fromUrl cairiam como documento
  if (!tipo || !ehAnalisavel(tipo) || arquivo.bytes.length > LIMITE_BYTES) {
    throw new DesignError("O mockup vai ao cliente como foto: envie PNG, JPEG ou WEBP de até 16 MB.", 400);
  }
  return transaction(async (tx) => {
    const [j] = await tx.query<{ stage: Etapa }>("SELECT stage FROM design_jobs WHERE id = $1 FOR UPDATE", [jobId]);
    if (!j) throw new DesignError("Job não encontrado.", 404);
    if (!["EM_CRIACAO", "AJUSTES", "AGUARDANDO_CLIENTE"].includes(j.stage)) throw new DesignError("Comece o job antes de subir o mockup.");
    const [{ v }] = await tx.query<{ v: number }>(
      "SELECT COALESCE(MAX(versao), 0) + 1 AS v FROM design_assets WHERE job_id = $1 AND tipo = 'MOCKUP'",
      [jobId]
    );
    await salvarAsset(tx, jobId, "MOCKUP", { ...arquivo, tipo }, v);
    await registrarEvento(tx, jobId, atorId, "mockup_anexado", { versao: v });
    return { versao: v };
  });
}

async function enviarImagemAoCliente(jobId: string, versao: number, legenda: string, chave: string): Promise<void> {
  const a = await one<{ arquivo: string; phone: string }>(
    `SELECT a.arquivo, l.phone FROM design_assets a JOIN design_jobs j ON j.id = a.job_id JOIN leads l ON l.id = j.lead_id
     WHERE a.job_id = $1 AND a.tipo = 'MOCKUP' AND a.versao = $2`,
    [jobId, versao]
  );
  if (!a) throw new DesignError("Versão do mockup não encontrada.", 404);
  const url = urlAbsoluta(await armazem().urlTemporaria(a.arquivo));
  const r = await callPonte<{ id: string }>("/enviar-midia", { telefone: a.phone, url, legenda: legenda.slice(0, 1000), chave });
  if (!r.ok) throw new DesignError(r.error, r.status === 503 ? 503 : 502);
}

export async function enviarMockup(jobId: string, versao: number, legenda: string, atorId: string): Promise<void> {
  const atual = await one<{ stage: Etapa }>("SELECT stage FROM design_jobs WHERE id = $1", [jobId]);
  if (!atual) throw new DesignError("Job não encontrado.", 404);
  if (!podeTransitar(atual.stage, "AGUARDANDO_CLIENTE")) throw new DesignError("O mockup só sai de Em criação ou Ajustes.");
  // Ponte antes do banco, como a rota /enviar: falhou o envio, nada muda
  await enviarImagemAoCliente(jobId, versao, legenda, `mockup:${jobId}:${versao}`);
  await transaction(async (tx) => {
    await mudarEtapaTx(tx, jobId, "AGUARDANDO_CLIENTE", atorId);
    const [j] = await tx.query<{ lead_id: string }>("UPDATE design_jobs SET conversa_com_designer = true WHERE id = $1 RETURNING lead_id", [jobId]);
    await tx.query("UPDATE leads SET agent_mode = 'humano' WHERE id = $1", [j.lead_id]);
    await registrarEvento(tx, jobId, atorId, "mockup_enviado", { versao });
  });
}

export async function pedirConfirmacao(jobId: string, atorId: string): Promise<void> {
  const atual = await one<{ stage: Etapa; versao: number | null }>(
    `SELECT j.stage, (SELECT (e.dados->>'versao')::int FROM design_events e
       WHERE e.job_id = j.id AND e.tipo = 'mockup_enviado' ORDER BY e.created_at DESC LIMIT 1) AS versao
     FROM design_jobs j WHERE j.id = $1`,
    [jobId]
  );
  if (!atual) throw new DesignError("Job não encontrado.", 404);
  if (atual.stage !== "AGUARDANDO_CLIENTE" || !atual.versao) {
    throw new DesignError("Só dá para pedir confirmação com o mockup enviado e aguardando o cliente.");
  }
  const versao = atual.versao;
  const legenda = LEGENDA_CONFIRMACAO(versao);
  await enviarImagemAoCliente(jobId, versao, legenda, `confirmacao:${jobId}:${versao}`);
  await transaction(async (tx) => {
    await tx.query("SELECT id FROM design_jobs WHERE id = $1 FOR UPDATE", [jobId]);
    const [agora] = await tx.query<{ stage: Etapa; versao: number | null }>(
      `SELECT j.stage, (SELECT (e.dados->>'versao')::int FROM design_events e
         WHERE e.job_id = j.id AND e.tipo = 'mockup_enviado' ORDER BY e.created_at DESC LIMIT 1) AS versao
       FROM design_jobs j WHERE j.id = $1`,
      [jobId]
    );
    // O job pode ter ido para Ajustes ou recebido outra versão enquanto a foto ia
    if (agora?.stage !== "AGUARDANDO_CLIENTE" || agora.versao !== versao) {
      throw new DesignError("O job mudou durante o envio. Peça a confirmação de novo.");
    }
    await tx.query("UPDATE design_jobs SET confirmacao_pedida_em = NOW(), confirmacao_versao = $2, updated_at = NOW() WHERE id = $1", [jobId, versao]);
    await registrarEvento(tx, jobId, atorId, "confirmacao_pedida", { versao, texto: legenda });
  });
}

/**
 * Chamada a cada mensagem do cliente. Só o "APROVO" com confirmação pendente aprova. mensagemId é o id do
 * WhatsApp: vai na devolução para a ponte não entregar esse mesmo "APROVO" à Lia.
 */
export async function receberRespostaDoCliente(
  leadId: string,
  texto: string,
  mensagemId?: string,
  enviadaEm?: string
): Promise<"aprovado" | "nao_confirmou" | "sem_confirmacao_pendente"> {
  const r = await transaction(async (tx) => {
    const [j] = await tx.query<{ id: string; designer_id: string | null; order_id: string | null; confirmacao_versao: number; assigned_to: string | null }>(
      `SELECT j.id, j.designer_id, j.order_id, j.confirmacao_versao, l.assigned_to
       FROM design_jobs j JOIN leads l ON l.id = j.lead_id
       WHERE j.lead_id = $1 AND j.stage = 'AGUARDANDO_CLIENTE' AND j.confirmacao_pedida_em IS NOT NULL
         -- Mensagem escrita antes do pedido de confirmação (entregue com atraso) não responde a ele;
         -- 30 s de folga para a diferença entre o relógio do WhatsApp e o do servidor
         AND ($2::timestamptz IS NULL OR $2::timestamptz >= j.confirmacao_pedida_em - interval '30 seconds')
       FOR UPDATE OF j`,
      [leadId, enviadaEm ?? null]
    );
    if (!j) return { resultado: "sem_confirmacao_pendente" as const, jobId: null };
    const aprovou = ehAprovacao(texto);
    await registrarEvento(tx, j.id, null, "resposta_confirmacao", { texto: texto.slice(0, 500), aprovou });
    if (!aprovou) {
      if (j.designer_id) {
        await notify(tx, j.designer_id, "Cliente respondeu, mas não confirmou com APROVO", texto.slice(0, 120), `/app/design/${j.id}`);
      }
      return { resultado: "nao_confirmou" as const, jobId: j.id };
    }
    await mudarEtapaTx(tx, j.id, "APROVADO", null);
    await tx.query(
      `INSERT INTO design_assets (job_id, tipo, arquivo, mime, bytes, meta, versao)
       SELECT job_id, 'ARTE_FINAL', arquivo, mime, bytes, meta, versao FROM design_assets WHERE job_id = $1 AND tipo = 'MOCKUP' AND versao = $2`,
      [j.id, j.confirmacao_versao]
    );
    await registrarEvento(tx, j.id, null, "aprovado", { versao: j.confirmacao_versao });
    if (j.order_id) {
      const [o] = await tx.query<{ stage: string }>("SELECT stage FROM orders WHERE id = $1 FOR UPDATE", [j.order_id]);
      // Só adianta o pedido que ainda espera a arte; o que já passou da produção não volta
      if (o && (o.stage === "CONFIRMADO" || o.stage === "ARTE")) {
        await tx.query("UPDATE orders SET stage = 'PRODUCAO', stage_changed_at = NOW(), late_alert_at = NULL WHERE id = $1", [j.order_id]);
        await tx.query("INSERT INTO order_events (order_id, user_id, from_stage, to_stage) VALUES ($1, NULL, $2, 'PRODUCAO')", [j.order_id, o.stage]);
      }
    } else if (j.assigned_to) {
      await notify(tx, j.assigned_to, "Arte aprovada, falta o pedido", "O cliente aprovou a arte com APROVO.", `/app/crm?lead=${leadId}`);
    }
    return { resultado: "aprovado" as const, jobId: j.id };
  });
  if (r.resultado === "aprovado" && r.jobId) await devolverAoAtendimento(r.jobId, null, undefined, mensagemId ? [mensagemId] : []);
  return r.resultado;
}

/**
 * Tira a conversa do designer. Volta para a Lia, a não ser que o vendedor já atendesse quando o job abriu:
 * aí só avisa o vendedor. Ponte fora não desfaz nada; o designer é avisado para tentar de novo.
 */
export async function devolverAoAtendimento(jobId: string, atorId: string | null, nota?: string, consumidas: string[] = []): Promise<void> {
  const j = await one<{ lead_id: string; phone: string; designer_id: string | null; assigned_to: string | null; modo_anterior: string | null }>(
    `SELECT j.lead_id, l.phone, j.designer_id, l.assigned_to,
       (SELECT e.dados->>'modo_anterior' FROM design_events e WHERE e.job_id = j.id AND e.tipo = 'criado' LIMIT 1) AS modo_anterior
     FROM design_jobs j JOIN leads l ON l.id = j.lead_id WHERE j.id = $1`,
    [jobId]
  );
  if (!j) throw new DesignError("Job não encontrado.", 404);
  const voltaParaLia = j.modo_anterior !== "humano";
  const ponte = voltaParaLia ? await callPonte("/devolver", { telefone: j.phone, ...(nota ? { nota } : {}), ...(consumidas.length ? { consumidas } : {}) }) : { ok: true as const };
  await transaction(async (tx) => {
    if (!ponte.ok) {
      if (j.designer_id) {
        await notify(tx, j.designer_id, "Não consegui devolver a conversa à Lia", "Use Devolver ao atendimento de novo.", `/app/design/${jobId}`);
      }
      await registrarEvento(tx, jobId, atorId, "devolucao_falhou");
      return;
    }
    await tx.query("UPDATE design_jobs SET conversa_com_designer = false, updated_at = NOW() WHERE id = $1", [jobId]);
    if (voltaParaLia) {
      await tx.query("UPDATE leads SET agent_mode = 'ia', needs_attention = false, attention_reason = NULL WHERE id = $1", [j.lead_id]);
      await logEvent(tx, j.lead_id, atorId, "ATENDIMENTO", { modo: "ia", ...(nota ? { nota } : {}) });
    } else if (j.assigned_to) {
      await notify(tx, j.assigned_to, "A conversa voltou para você", "O designer terminou o job de design.", `/app/crm?lead=${j.lead_id}`);
    }
    await registrarEvento(tx, jobId, atorId, "devolvido", { para: voltaParaLia ? "lia" : "vendedor" });
  });
}

/* ------------------------------------------------------------------ */
/*  Leituras para as rotas e telas                                     */
/* ------------------------------------------------------------------ */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Usuario = { id: string; role: Role };

export type CardJob = {
  id: string;
  lead_id: string;
  cliente: string;
  peca: string | null;
  prazo: string | null;
  prioridade: string;
  stage: Etapa;
  ia_status: string;
  designer_id: string | null;
  miniatura: string | null;
};

export async function listarJobs(user: Usuario): Promise<CardJob[]> {
  const params: unknown[] = [];
  let escopo = "TRUE";
  if (user.role !== "ADMIN") {
    params.push(user.id);
    // Job sem dono (aberto quando não havia designer ativo) aparece para todos, que podem assumir
    escopo = "(j.designer_id = $1 OR j.designer_id IS NULL)";
  }
  const rows = await query<Omit<CardJob, "miniatura"> & { original: string | null }>(
    `SELECT j.id, j.lead_id, COALESCE(l.name, 'Cliente') AS cliente, j.ficha->>'peca' AS peca, j.prazo, j.prioridade, j.stage,
       j.ia_status, j.designer_id,
       (SELECT a.arquivo FROM design_assets a WHERE a.job_id = j.id AND a.tipo = 'ORIGINAL'
          AND a.mime IN ('image/png','image/jpeg','image/webp') ORDER BY a.created_at DESC LIMIT 1) AS original
     FROM design_jobs j JOIN leads l ON l.id = j.lead_id
     WHERE ${escopo} AND (j.stage NOT IN ('APROVADO','CANCELADO') OR (j.stage = 'APROVADO' AND j.updated_at > NOW() - interval '14 days'))
     ORDER BY j.prioridade = 'alta' DESC, j.created_at`,
    params
  );
  return Promise.all(
    rows.map(async ({ original, ...r }) => ({ ...r, miniatura: original ? await armazem().urlTemporaria(original) : null }))
  );
}

/** Job que o usuário pode ver: admin vê todos; designer, os dele e os sem designer (para Assumir). */
export async function jobDoUsuario(jobId: string, user: Usuario): Promise<{ id: string; lead_id: string; designer_id: string | null; stage: Etapa } | null> {
  if (!UUID.test(jobId)) return null;
  const j = await one<{ id: string; lead_id: string; designer_id: string | null; stage: Etapa }>(
    "SELECT id, lead_id, designer_id, stage FROM design_jobs WHERE id = $1",
    [jobId]
  );
  if (!j) return null;
  if (user.role === "ADMIN") return j;
  return user.role === "DESIGNER" && (j.designer_id === user.id || j.designer_id === null) ? j : null;
}

export async function assumir(jobId: string, designerId: string): Promise<void> {
  await transaction(async (tx) => {
    const [j] = await tx.query<{ designer_id: string | null }>("SELECT designer_id FROM design_jobs WHERE id = $1 FOR UPDATE", [jobId]);
    if (!j) throw new DesignError("Job não encontrado.", 404);
    if (j.designer_id) throw new DesignError("Este job já tem designer.");
    await tx.query("UPDATE design_jobs SET designer_id = $2, updated_at = NOW() WHERE id = $1", [jobId, designerId]);
    await registrarEvento(tx, jobId, designerId, "atribuido", { designer_id: designerId, assumido: true });
  });
}

export type AssetDetalhe = { id: string; tipo: string; mime: string | null; versao: number; nome: string | null; url: string; download: boolean; created_at: string };

export async function detalharJob(jobId: string) {
  const job = await one<Record<string, unknown> & { id: string; lead_id: string; stage: Etapa }>(
    `SELECT j.*, COALESCE(l.name, 'Cliente') AS cliente, l.agent_mode, u.name AS designer_nome
     FROM design_jobs j JOIN leads l ON l.id = j.lead_id LEFT JOIN users u ON u.id = j.designer_id WHERE j.id = $1`,
    [jobId]
  );
  if (!job) throw new DesignError("Job não encontrado.", 404);
  const [assets, eventos, mensagens] = await Promise.all([
    query<{ id: string; tipo: string; arquivo: string; mime: string | null; versao: number; meta: { nome?: string }; created_at: string }>(
      "SELECT id, tipo, arquivo, mime, versao, meta, created_at FROM design_assets WHERE job_id = $1 ORDER BY tipo, versao, created_at",
      [jobId]
    ),
    query(
      `SELECT e.id, e.tipo, e.dados, e.created_at, u.name AS ator FROM design_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.job_id = $1 ORDER BY e.created_at DESC LIMIT 100`,
      [jobId]
    ),
    query(
      `SELECT * FROM (SELECT m.id, m.author, u.name AS sent_by_name, m.body, m.sent_at, m.kind,
           m.transcription, m.transcription_status, (m.media_key IS NOT NULL) AS has_media FROM messages m
         LEFT JOIN users u ON u.id = m.sent_by WHERE m.lead_id = $1 ORDER BY m.sent_at DESC LIMIT 50) t ORDER BY sent_at`,
      [job.lead_id]
    ),
  ]);
  const comUrl: AssetDetalhe[] = await Promise.all(
    assets.map(async (a) => ({
      id: a.id,
      tipo: a.tipo,
      mime: a.mime,
      versao: a.versao,
      nome: a.meta?.nome ?? null,
      created_at: a.created_at,
      url: await armazem().urlTemporaria(a.arquivo),
      // SVG pode carregar script e PDF não cabe num <img>: os dois só como download
      download: a.mime !== "image/png" && a.mime !== "image/jpeg" && a.mime !== "image/webp",
    }))
  );
  return { job, assets: comUrl, eventos, mensagens };
}

export async function jobAbertoDoLead(leadId: string): Promise<{ id: string; stage: Etapa } | null> {
  return one<{ id: string; stage: Etapa }>("SELECT id, stage FROM design_jobs WHERE lead_id = $1 AND stage NOT IN ('APROVADO','CANCELADO')", [leadId]);
}

/**
 * Lead ou pedido entrou na etapa ARTE: abre o job (ou não faz nada, se já houver um aberto).
 * A mudança de etapa já valeu; uma falha aqui só vai para o log.
 */
export async function gatilhoArte(p: { leadId: string | null; orderId?: string; atorId: string }): Promise<void> {
  if (!p.leadId) return; // pedido sem lead: design_jobs.lead_id é obrigatório
  await abrirOuAnexar({ leadId: p.leadId, origem: "PEDIDO", requestedBy: p.atorId, orderId: p.orderId ?? null, imagens: [] }).catch((err) =>
    console.error("abrir job de design pela etapa ARTE:", err)
  );
}

/** Designer escreveu ao cliente pelo CRM: as respostas passam a avisar ele. */
export async function ligarConversaComDesigner(leadId: string, designerId: string): Promise<void> {
  await query(
    "UPDATE design_jobs SET conversa_com_designer = true, updated_at = NOW() WHERE lead_id = $1 AND designer_id = $2 AND stage NOT IN ('APROVADO','CANCELADO')",
    [leadId, designerId]
  );
}

/** Designer que está com a conversa do lead agora (job aberto com conversa_com_designer). */
export async function designerDaConversa(tx: Executor, leadId: string): Promise<string | null> {
  const [j] = await tx.query<{ designer_id: string | null }>(
    "SELECT designer_id FROM design_jobs WHERE lead_id = $1 AND conversa_com_designer AND stage NOT IN ('APROVADO','CANCELADO')",
    [leadId]
  );
  return j?.designer_id ?? null;
}
