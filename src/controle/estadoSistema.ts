import type { Banco } from "../db/banco.js";
import { jsonb, logarErroBanco } from "../db/banco.js";

const RELEITURA_MS = 30_000;

export interface EstadoSistema {
  suspenso: boolean;
  suspensoPor?: string;
  suspensoEm?: string;
  /** Ferramentas desligadas em runtime (complementa FERRAMENTAS_DESLIGADAS do .env). */
  ferramentasDesligadas?: string[];
}

let atual: EstadoSistema = { suspenso: false };
let banco: Banco | null = null;
let timer: NodeJS.Timeout | null = null;
// Cada escrita local invalida leituras que já estavam em voo (senão o SELECT antigo sobrescreve o novo valor).
let versao = 0;

function valido(bruto: unknown): EstadoSistema {
  if (!bruto || typeof bruto !== "object" || typeof (bruto as Record<string, unknown>).suspenso !== "boolean") {
    return { suspenso: false };
  }
  return bruto as EstadoSistema;
}

async function ler(b: Banco): Promise<void> {
  const v = versao;
  const [linha] = await b.query<{ estado: unknown }>("SELECT estado FROM agente.estado_sistema WHERE id = 1");
  if (v === versao) atual = linha ? valido(linha.estado) : { suspenso: false };
}

async function reler(): Promise<void> {
  if (!banco) return;
  try {
    await ler(banco);
  } catch (err) {
    // Sem banco, vale o último estado lido: suspenso não pode virar ativo por falha de leitura.
    console.error(JSON.stringify({ type: "estado_sistema_nao_lido", ...logarErroBanco(err) }));
  }
}

export async function ligarEstadoSistema(b: Banco, intervaloMs = RELEITURA_MS): Promise<() => void> {
  if (timer) clearInterval(timer);
  // A primeira leitura propaga o erro: sem saber se está suspenso, o processo não deve subir como ativo.
  await ler(b);
  banco = b;
  const t = setInterval(() => void reler(), intervaloMs);
  t.unref();
  timer = t;
  return () => clearInterval(t);
}

export function lerEstadoSistema(): EstadoSistema {
  return atual;
}

export async function escreverEstadoSistema(estado: EstadoSistema): Promise<void> {
  versao++;
  if (!banco) {
    atual = estado;
    return;
  }
  await banco.query(
    `INSERT INTO agente.estado_sistema (id, estado, atualizado_em) VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET estado = EXCLUDED.estado, atualizado_em = now()`,
    [jsonb(estado)]
  );
  atual = estado; // só depois do INSERT: se o banco falhar, o valor visível não muda
}

/** Volta ao padrão e desliga o banco. Usado nos testes. */
export function invalidarCache(): void {
  if (timer) clearInterval(timer);
  timer = null;
  versao = 0;
  atual = { suspenso: false };
  banco = null;
}
