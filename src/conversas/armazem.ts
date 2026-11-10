import { jsonb, type Banco } from "../db/banco.js";

/** Só guarda e devolve o documento; validação e cortes ficam no RepositorioConversas. */
export interface ArmazemConversas {
  ler(telefone: string): Promise<unknown | null>;
  gravar(telefone: string, doc: unknown): Promise<void>;
  separarCorrompido(telefone: string, doc: unknown, erro: string): Promise<void>;
}

export class MemoriaConversas implements ArmazemConversas {
  private readonly docs = new Map<string, string>();
  readonly corrompidos: Array<{ telefone: string; erro: string }> = [];

  async ler(telefone: string): Promise<unknown | null> {
    const doc = this.docs.get(telefone);
    return doc === undefined ? null : JSON.parse(doc);
  }
  async gravar(telefone: string, doc: unknown): Promise<void> {
    this.docs.set(telefone, JSON.stringify(doc));
  }
  async separarCorrompido(telefone: string, _doc: unknown, erro: string): Promise<void> {
    this.docs.delete(telefone);
    this.corrompidos.push({ telefone, erro });
  }
}

export class PgConversas implements ArmazemConversas {
  constructor(private readonly banco: Banco) {}

  async ler(telefone: string): Promise<unknown | null> {
    const linhas = await this.banco.query<{ doc: unknown }>("SELECT doc FROM agente.conversas WHERE telefone = $1", [telefone]);
    return linhas[0]?.doc ?? null;
  }

  async gravar(telefone: string, doc: unknown): Promise<void> {
    await this.banco.query(
      `INSERT INTO agente.conversas (telefone, doc, atualizado_em) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (telefone) DO UPDATE SET doc = EXCLUDED.doc, atualizado_em = now()`,
      [telefone, jsonb(doc)]
    );
  }

  async separarCorrompido(telefone: string, doc: unknown, erro: string): Promise<void> {
    await this.banco.transacao(async (tx) => {
      await tx.query("INSERT INTO agente.conversas_corrompidas (telefone, doc, erro) VALUES ($1, $2::jsonb, $3)", [
        telefone,
        jsonb(doc),
        erro.slice(0, 500),
      ]);
      await tx.query("DELETE FROM agente.conversas WHERE telefone = $1", [telefone]);
    });
  }
}
