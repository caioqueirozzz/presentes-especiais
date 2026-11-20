import { z } from "zod";
import type { Evento, ItemResposta, Modo } from "../contrato/esquemas.js";
import { itemRespostaSchema } from "../contrato/esquemas.js";
import type { LogPonte } from "./log.js";
import type { Banco } from "../db/banco.js";

/** Partes da resposta às mensagens `ids` que já chegaram ao cliente. */
export interface EntregaParcial {
  ids: string[];
  partes: ItemResposta[];
}

/** O que a ponte precisa lembrar depois de reiniciar para não repetir resposta nem esquecer o atendente. */
export interface EstadoPonte {
  versao: 1;
  modos: Record<string, Modo>;
  eventosPendentes: Evento[];
  avisosPendentes: string[];
  concluidos: string[];
  /** Por telefone. Opcional: estado gravado antes da rodada 3 não tem. */
  entregasParciais?: Record<string, EntregaParcial>;
}

export interface ArmazemPonte {
  carregar(): Promise<EstadoPonte>;
  salvar(estado: EstadoPonte): Promise<void>;
}

export function estadoVazio(): EstadoPonte {
  return { versao: 1, modos: {}, eventosPendentes: [], avisosPendentes: [], concluidos: [], entregasParciais: {} };
}

export class MemoriaEstadoPonte implements ArmazemPonte {
  constructor(public estado: EstadoPonte = estadoVazio()) {}

  async carregar(): Promise<EstadoPonte> {
    return structuredClone(this.estado);
  }

  async salvar(estado: EstadoPonte): Promise<void> {
    this.estado = structuredClone(estado);
  }
}

export function normalizarEstadoPonte(bruto: unknown): EstadoPonte {
  const e = bruto as EstadoPonte;
  if (
    e?.versao !== 1 ||
    !Array.isArray(e.concluidos) ||
    !Array.isArray(e.eventosPendentes) ||
    !Array.isArray(e.avisosPendentes) ||
    typeof e.modos !== "object" ||
    e.modos === null
  ) {
    throw new Error("formato inesperado");
  }
  e.entregasParciais = entregasValidas(e.entregasParciais);
  return e;
}

export class PgEstadoPonte implements ArmazemPonte {
  constructor(
    private readonly banco: Banco,
    private readonly log: LogPonte = () => {}
  ) {}

  async carregar(): Promise<EstadoPonte> {
    const [linha] = await this.banco.query<{ doc: unknown }>("SELECT doc FROM agente.estado_ponte WHERE id = 1");
    if (!linha) return estadoVazio();
    try {
      return normalizarEstadoPonte(linha.doc);
    } catch (err) {
      this.log({ type: "alerta", gravidade: "alta", motivo: "estado_da_ponte_corrompido", erro: String(err) });
      return estadoVazio();
    }
  }

  async salvar(estado: EstadoPonte): Promise<void> {
    await this.banco.query(
      `INSERT INTO agente.estado_ponte (id, doc, atualizado_em) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, atualizado_em = now()`,
      [JSON.stringify(estado)]
    );
  }
}

const textos = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const partesValidas = (v: unknown): v is ItemResposta[] => z.array(itemRespostaSchema).safeParse(v).success;

function entregasValidas(bruto: unknown): Record<string, EntregaParcial> {
  if (typeof bruto !== "object" || bruto === null) return {};
  const validas: Record<string, EntregaParcial> = {};
  for (const [telefone, e] of Object.entries(bruto as Record<string, Partial<EntregaParcial>>)) {
    if (textos(e?.ids) && partesValidas(e?.partes)) validas[telefone] = { ids: e.ids, partes: e.partes };
  }
  return validas;
}
