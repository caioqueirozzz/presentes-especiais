/**
 * Índice local de pedidos (Fase 2, item 4).
 *
 * `GET /order/{id}` só aceita o UUID interno, e `GET /order` filtra apenas por
 * vendedor e período — não há busca por código, telefone ou e-mail. O cliente,
 * porém, só conhece o código. O job lê os pedidos por período e grava o mínimo
 * necessário para localizar um pedido pelo que o cliente sabe dizer.
 *
 * Guarda só: id, código, telefone e e-mail normalizados, status e data.
 * Nada de CPF, endereço, boleto ou nota — esses nunca saem de `GET /order/{id}`,
 * que é consultado só depois da validação.
 */
import type { BrindeMeClient } from "./client.js";
import type { Banco } from "../../db/banco.js";
import { normalizePhone } from "../../agent/state.js";

export interface PedidoIndexado {
  id: string;
  codigo: string;
  /** Só dígitos, para comparação. */
  telefone: string;
  /** Minúsculas, para comparação. */
  email: string;
  status: string;
  criado_em: string;
  sincronizado_em: string;
}

export interface OrderIndexStore {
  carregar(): Promise<PedidoIndexado[]>;
  salvar(pedidos: PedidoIndexado[]): Promise<void>;
}

export class MemoryOrderIndexStore implements OrderIndexStore {
  constructor(private pedidos: PedidoIndexado[] = []) {}
  async carregar(): Promise<PedidoIndexado[]> {
    return this.pedidos;
  }
  async salvar(pedidos: PedidoIndexado[]): Promise<void> {
    this.pedidos = pedidos;
  }
}

export class PgOrderIndexStore implements OrderIndexStore {
  constructor(private readonly banco: Banco) {}

  async carregar(): Promise<PedidoIndexado[]> {
    return this.banco.query<PedidoIndexado>(
      "SELECT id, codigo, telefone, email, status, criado_em, sincronizado_em FROM agente.pedidos ORDER BY criado_em, id"
    );
  }

  async salvar(pedidos: PedidoIndexado[]): Promise<void> {
    await this.banco.transacao(async (tx) => {
      await tx.query("DELETE FROM agente.pedidos");
      if (pedidos.length === 0) return;
      await tx.query(
        `INSERT INTO agente.pedidos (id, codigo, telefone, email, status, criado_em, sincronizado_em)
         SELECT id, codigo, telefone, email, status, criado_em, sincronizado_em
         FROM jsonb_to_recordset($1::jsonb) AS p(id TEXT, codigo TEXT, telefone TEXT, email TEXT, status TEXT, criado_em TEXT, sincronizado_em TEXT)`,
        [JSON.stringify(pedidos)]
      );
    });
  }
}

export interface SyncOptions {
  /** Janela para trás, em dias. */
  dias?: number;
  perPage?: number;
  /** Teto de páginas, para não varrer o histórico inteiro sem querer. */
  maxPaginas?: number;
}

export interface SyncResultado {
  lidos: number;
  novos: number;
  atualizados: number;
  paginas: number;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Lê os pedidos da janela e atualiza o índice. Idempotente: rodar duas vezes
 * seguidas não duplica nada — a chave é o id do pedido.
 */
export async function sincronizarPedidos(
  client: BrindeMeClient,
  store: OrderIndexStore,
  options?: SyncOptions
): Promise<SyncResultado> {
  const dias = options?.dias ?? 180;
  const perPage = options?.perPage ?? 100;
  const maxPaginas = options?.maxPaginas ?? 50;

  const fim = new Date();
  const inicio = new Date(fim.getTime() - dias * 24 * 60 * 60 * 1000);

  const existentes = new Map((await store.carregar()).map((p) => [p.id, p]));
  const agora = new Date().toISOString();

  let lidos = 0;
  let novos = 0;
  let atualizados = 0;
  let pagina = 1;

  for (; pagina <= maxPaginas; pagina++) {
    const lote = await client.listOrders({
      per_page: perPage,
      page: pagina,
      start_date: iso(inicio),
      end_date: iso(fim),
    });

    for (const o of lote.data) {
      lidos++;
      const registro: PedidoIndexado = {
        id: o.id,
        codigo: String(o.code),
        telefone: normalizePhone(o.customer_phone ?? ""),
        email: (o.customer_email ?? "").toLowerCase().trim(),
        status: o.status_name ?? "",
        criado_em: o.created_at ?? "",
        sincronizado_em: agora,
      };
      if (existentes.has(o.id)) atualizados++;
      else novos++;
      existentes.set(o.id, registro);
    }

    const ultima = lote.last_page ?? 1;
    if (lote.data.length === 0 || pagina >= ultima) break;
  }

  await store.salvar([...existentes.values()]);
  return { lidos, novos, atualizados, paginas: pagina };
}

export interface BuscaPedido {
  codigo: string;
  telefone?: string;
  email?: string;
}

/**
 * Localiza o pedido pelo código e confere se o contato bate. Devolve o UUID
 * para então buscar o pedido completo em `GET /order/{id}`.
 *
 * Nunca devolve dado do pedido — só o id e se validou.
 */
export async function localizarPedido(
  store: OrderIndexStore,
  busca: BuscaPedido
): Promise<{ encontrado: false } | { encontrado: true; id: string; validado: boolean }> {
  const codigo = busca.codigo.trim().replace(/^#/, "");
  const pedido = (await store.carregar()).find((p) => p.codigo === codigo);
  if (!pedido) return { encontrado: false };

  const telefoneBate =
    !!busca.telefone && !!pedido.telefone && telefonesIguais(busca.telefone, pedido.telefone);
  const emailBate =
    !!busca.email && !!pedido.email && busca.email.toLowerCase().trim() === pedido.email;

  return { encontrado: true, id: pedido.id, validado: telefoneBate || emailBate };
}

function telefonesIguais(a: string, b: string): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (na === nb) return true;
  const strip55 = (p: string) => (p.startsWith("55") && p.length > 11 ? p.slice(2) : p);
  return strip55(na) === strip55(nb);
}
