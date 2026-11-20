import type { Banco, Executor } from "../db/banco.js";
import { phoneMatches } from "../agent/state.js";
import { estadoVazio, normalizarEstadoPonte, type EstadoPonte } from "../whatsapp/estadoPonte.js";

const DIA_MS = 86_400_000;

export interface PlanoBanco {
  telefones: string[];
  conversaIds: string[];
  lacunas: number;
  registrosPonte: number;
  /** Pedido de um cliente: o telefone sai da ponte mesmo sem conversa. */
  telefoneCliente?: string;
}

export function tirarTelefonesDoEstadoPonte(estado: EstadoPonte, telefones: string[]): { estado: EstadoPonte; registros: number } {
  const sai = (tel: string) => telefones.some((t) => phoneMatches(tel, t));
  const novo: EstadoPonte = structuredClone(estado);
  let registros = 0;
  for (const mapa of [novo.modos, novo.entregasParciais ?? {}] as Array<Record<string, unknown>>) {
    for (const tel of Object.keys(mapa)) {
      if (sai(tel)) {
        delete mapa[tel];
        registros++;
      }
    }
  }
  const antes = novo.eventosPendentes.length;
  novo.eventosPendentes = novo.eventosPendentes.filter((e) => !sai((e as { telefone?: string }).telefone ?? ""));
  registros += antes - novo.eventosPendentes.length;
  return { estado: novo, registros };
}

/** null = sem linha ou ilegível; quem grava não pode sobrescrever nesse caso. */
async function estadoPonte(banco: Executor, travar = false): Promise<EstadoPonte | null> {
  const [linha] = await banco.query<{ doc: unknown }>(`SELECT doc FROM agente.estado_ponte WHERE id = 1${travar ? " FOR UPDATE" : ""}`);
  if (!linha) return null;
  try {
    return normalizarEstadoPonte(linha.doc);
  } catch {
    return null;
  }
}

function limite(dias: number, agora: number): Date {
  if (!Number.isFinite(dias) || dias < 1) throw new Error("prazo de retenção precisa ser de pelo menos 1 dia");
  return new Date(agora - dias * DIA_MS);
}

async function montar(banco: Executor, linhas: Array<{ telefone: string; conversa_id: string | null }>, lacunas: number): Promise<PlanoBanco> {
  const telefones = linhas.map((l) => l.telefone);
  return {
    telefones,
    conversaIds: linhas.map((l) => l.conversa_id).filter((c): c is string => !!c),
    lacunas,
    registrosPonte: telefones.length ? tirarTelefonesDoEstadoPonte((await estadoPonte(banco)) ?? estadoVazio(), telefones).registros : 0,
  };
}

export async function planejarPorIdade(banco: Banco, dias: number, agora = Date.now()): Promise<PlanoBanco> {
  const corte = limite(dias, agora);
  const linhas = await banco.query<{ telefone: string; conversa_id: string | null }>(
    "SELECT telefone, doc->'estado'->>'conversaId' AS conversa_id FROM agente.conversas WHERE atualizado_em < $1 ORDER BY telefone",
    [corte]
  );
  const [{ n }] = await banco.query<{ n: number }>("SELECT count(*)::int AS n FROM agente.lacunas WHERE registrado_em < $1", [corte]);
  return montar(banco, linhas, n);
}

export async function planejarCliente(banco: Banco, telefone: string): Promise<PlanoBanco> {
  if (!/^\d{10,15}$/.test(telefone)) throw new Error("telefone só com dígitos, com DDI");
  const linhas = await banco.query<{ telefone: string; conversa_id: string | null }>(
    "SELECT telefone, doc->'estado'->>'conversaId' AS conversa_id FROM agente.conversas WHERE telefone = $1",
    [telefone]
  );
  const ids = linhas.map((l) => l.conversa_id).filter((c): c is string => !!c);
  const [{ n }] = await banco.query<{ n: number }>("SELECT count(*)::int AS n FROM agente.lacunas WHERE conversa_id = ANY($1::text[])", [ids]);
  const plano = await montar(banco, linhas, n);
  // O estado da ponte guarda o telefone mesmo sem conversa: o cliente sai de lá também.
  const registrosPonte = tirarTelefonesDoEstadoPonte((await estadoPonte(banco)) ?? estadoVazio(), [telefone]).registros;
  return { ...plano, registrosPonte, telefoneCliente: telefone };
}

export async function telefonesAtivos(banco: Banco, dias: number, agora = Date.now()): Promise<Set<string>> {
  const linhas = await banco.query<{ telefone: string }>("SELECT telefone FROM agente.conversas WHERE atualizado_em >= $1", [limite(dias, agora)]);
  return new Set(linhas.map((l) => l.telefone));
}

/** Apaga de vez. Só o script chama, e só com --executar. porIdade null = pedido de um cliente. */
export async function executarPlano(banco: Banco, plano: PlanoBanco, porIdade: { dias: number; agora: number } | null): Promise<void> {
  await banco.transacao(async (tx) => {
    // Por idade, a conversa que voltou a andar depois do plano fica (e a entrada dela na ponte também).
    const corte = porIdade ? limite(porIdade.dias, porIdade.agora) : null;
    const apagadas = corte
      ? await tx.query<{ telefone: string }>("DELETE FROM agente.conversas WHERE telefone = ANY($1::text[]) AND atualizado_em < $2 RETURNING telefone", [plano.telefones, corte])
      : await tx.query<{ telefone: string }>("DELETE FROM agente.conversas WHERE telefone = ANY($1::text[]) RETURNING telefone", [plano.telefones]);
    if (corte) await tx.query("DELETE FROM agente.lacunas WHERE registrado_em < $1", [corte]);
    else await tx.query("DELETE FROM agente.lacunas WHERE conversa_id = ANY($1::text[])", [plano.conversaIds]);
    const saem = corte ? apagadas.map((r) => r.telefone) : plano.telefoneCliente ? [plano.telefoneCliente] : [];
    if (saem.length === 0) return;
    const atual = await estadoPonte(tx, true);
    if (!atual) return; // ilegível ou ausente: não sobrescreve
    const { estado, registros } = tirarTelefonesDoEstadoPonte(atual, saem);
    if (registros > 0) await tx.query("UPDATE agente.estado_ponte SET doc = $1::jsonb, atualizado_em = now() WHERE id = 1", [JSON.stringify(estado)]);
  });
}
