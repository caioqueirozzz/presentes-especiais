import { z } from "zod";
import { createInitialState, type ConversationState } from "../agent/state.js";
import { respostaMensagensSchema, type RespostaMensagens } from "../contrato/esquemas.js";
import type { ResumoTransferencia } from "../tools/transferirHumano.js";
import type { ArmazemConversas } from "./armazem.js";

export const MAX_TURNOS_GUARDADOS = 20;
export const MAX_IDS_VISTOS = 1_000;
export const MAX_HISTORICO = 200;
export const MAX_ARQUIVOS_RECEBIDOS = 50;
export const MAX_FALHAS_GUARDADAS = 50;

export interface TurnoGuardado {
  turnoId: string;
  resposta: RespostaMensagens;
  /** Ids do lote; ausente em turnos salvos antes da revisão final. */
  ids?: string[];
  /** Quantas vezes o atendente tinha escrito quando a resposta foi gerada. */
  tomadas?: number;
}

export interface TransferenciaPendente {
  resumo: ResumoTransferencia;
  lacunas: string[];
}

export interface Conversa {
  versao: 1;
  estado: ConversationState;
  idsVistos: string[];
  turnos: TurnoGuardado[];
  /** turnoId → falhas seguidas do mesmo lote (a 2ª transfere). */
  falhasPorTurno: Record<string, number>;
  /** ISO das respostas da última hora, para o limite por telefone. */
  respostasRecentes: string[];
  /** Mensagens do atendente recebidas nesta conversa. */
  tomadas?: number;
  /** Transferência feita num turno que ainda não respondeu ao cliente (o processo pode ter caído no meio). */
  transferenciaPendente?: TransferenciaPendente;
  /** suspensoEm da suspensão em que o cliente já recebeu o aviso de fora do ar (um aviso por suspensão). */
  avisoSuspensao?: string;
}

const conversaSchema = z
  .object({
    versao: z.literal(1),
    estado: z
      .object({
        conversaId: z.string(),
        telefone: z.string(),
        modo: z.enum(["ia", "humano"]),
        cliente: z.object({}).passthrough(),
        necessidade: z.object({}).passthrough(),
        produtosDiscutidos: z.array(z.string()),
        subprodutoParaProduto: z.record(z.string()),
        artes: z.array(z.object({ ref: z.string(), arquivo: z.string() }).passthrough()),
        arquivosRecebidos: z
          .array(z.object({ nome: z.string(), caminho: z.string(), mime: z.string(), bytes: z.number() }))
          .optional(),
        falhasConsecutivas: z.number(),
        historico: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string(), timestamp: z.string() })),
      })
      .passthrough(),
    idsVistos: z.array(z.string()),
    turnos: z.array(
      z.object({
        turnoId: z.string(),
        resposta: respostaMensagensSchema,
        ids: z.array(z.string()).optional(),
        tomadas: z.number().optional(),
      })
    ),
    falhasPorTurno: z.record(z.number()),
    respostasRecentes: z.array(z.string()),
    tomadas: z.number().optional(),
    transferenciaPendente: z.object({ resumo: z.object({}).passthrough(), lacunas: z.array(z.string()) }).optional(),
  })
  .passthrough();

export function novaConversa(telefone: string): Conversa {
  return {
    versao: 1,
    estado: createInitialState(telefone),
    idsVistos: [],
    turnos: [],
    falhasPorTurno: {},
    respostasRecentes: [],
  };
}

const TELEFONE = /^\d{10,15}$/;

function exigirTelefone(telefone: string): void {
  if (!TELEFONE.test(telefone)) throw new Error("telefone inválido");
}

export class RepositorioConversas {
  /** Última gravação por telefone: a próxima espera a anterior, para não chegarem fora de ordem. */
  private readonly gravacoes = new Map<string, Promise<void>>();

  constructor(
    private readonly armazem: ArmazemConversas,
    private readonly log: (evento: Record<string, unknown>) => void = () => {}
  ) {}

  async existe(telefone: string): Promise<boolean> {
    exigirTelefone(telefone);
    return (await this.armazem.ler(telefone)) !== null;
  }

  async carregar(telefone: string): Promise<Conversa> {
    exigirTelefone(telefone);
    await this.gravacoes.get(telefone)?.catch(() => {});
    const bruto = await this.armazem.ler(telefone);
    if (bruto === null) return novaConversa(telefone);
    try {
      const c = conversaSchema.parse(bruto) as unknown as Conversa;
      if (c.estado.telefone !== telefone) throw new Error("documento de outro telefone");
      return c;
    } catch (err) {
      await this.armazem.separarCorrompido(telefone, bruto, String(err));
      this.log({ type: "alerta", gravidade: "alta", motivo: "estado_corrompido", tabela: "agente.conversas_corrompidas", erro: String(err).slice(0, 500) });
      return novaConversa(telefone);
    }
  }

  salvar(c: Conversa): Promise<void> {
    const telefone = c.estado.telefone;
    exigirTelefone(telefone);
    c.turnos = c.turnos.slice(-MAX_TURNOS_GUARDADOS);
    c.idsVistos = c.idsVistos.slice(-MAX_IDS_VISTOS);
    c.estado.historico = c.estado.historico.slice(-MAX_HISTORICO);
    if (c.estado.arquivosRecebidos) c.estado.arquivosRecebidos = c.estado.arquivosRecebidos.slice(-MAX_ARQUIVOS_RECEBIDOS);
    const falhas = Object.entries(c.falhasPorTurno);
    if (falhas.length > MAX_FALHAS_GUARDADAS) c.falhasPorTurno = Object.fromEntries(falhas.slice(-MAX_FALHAS_GUARDADAS));
    const retrato: unknown = JSON.parse(JSON.stringify(c));
    const anterior = this.gravacoes.get(telefone) ?? Promise.resolve();
    const esta = anterior.catch(() => {}).then(() => this.armazem.gravar(telefone, retrato));
    this.gravacoes.set(telefone, esta);
    void esta
      .finally(() => {
        if (this.gravacoes.get(telefone) === esta) this.gravacoes.delete(telefone);
      })
      .catch(() => {});
    return esta;
  }
}
