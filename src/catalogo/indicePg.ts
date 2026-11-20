import { jsonb, type Banco } from "../db/banco.js";
import { indiceVazio, VERSAO_INDICE, type IndiceCatalogo, type ProductIndexStore, type ProdutoIndexado } from "./indice.js";

const LOTE = 500;

/** Outro processo gravou o catálogo entre o `carregar` e o `salvar`: gravar agora apagaria a mudança dele. */
export class IndiceMudouError extends Error {
  constructor() {
    super("o índice mudou por fora durante a execução");
    this.name = "IndiceMudouError";
  }
}

const SQL_ASSINATURA = "SELECT coalesce(max(atualizado_em)::text, '') || ':' || count(*) AS s FROM agente.produtos";

/** Catálogo no banco. A busca não lê daqui a cada pergunta: carrega na partida e depois do sync. */
export class PgProductIndexStore implements ProductIndexStore {
  constructor(private readonly banco: Banco) {}

  async carregar(): Promise<IndiceCatalogo> {
    const [estado] = await this.banco.query<{ versao: number; sincronizado_em: string; completo: boolean }>(
      "SELECT versao, sincronizado_em, completo FROM agente.catalogo_estado WHERE id = 1"
    );
    if (!estado || estado.versao !== VERSAO_INDICE) return indiceVazio();
    const linhas = await this.banco.query<{ doc: ProdutoIndexado }>("SELECT doc FROM agente.produtos ORDER BY id");
    return { versao: estado.versao, sincronizado_em: estado.sincronizado_em, completo: estado.completo, produtos: linhas.map((l) => l.doc) };
  }

  /** Muda quando um doc muda ou um produto sai; um `salvar` idêntico não mexe. */
  async ultimaGravacao(): Promise<string> {
    const [r] = await this.banco.query<{ s: string }>(SQL_ASSINATURA);
    return r?.s ?? "";
  }

  /** `esperada` = `ultimaGravacao()` lida ANTES de carregar o índice que está sendo salvo; sem ela grava livre (primeira carga). */
  async salvar(indice: IndiceCatalogo, opcoes: { esperada?: string } = {}): Promise<void> {
    // Índice vazio apagaria o catálogo inteiro: o sync que listou zero produtos está errado, não a loja.
    if (indice.produtos.length === 0) throw new Error("índice vazio: recusado para não apagar o catálogo");
    await this.banco.transacao(async (tx) => {
      // Trava de transação: dois salvar não se intercalam, e o 2º vê o que o 1º gravou.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('agente.produtos'))");
      if (opcoes.esperada !== undefined) {
        const [atual] = await tx.query<{ s: string }>(SQL_ASSINATURA);
        if (atual?.s !== opcoes.esperada) throw new IndiceMudouError();
      }
      const ids = indice.produtos.map((p) => p.id);
      await tx.query("DELETE FROM agente.produtos WHERE NOT (id = ANY($1::text[]))", [ids]);
      for (let i = 0; i < indice.produtos.length; i += LOTE) {
        const lote = indice.produtos.slice(i, i + LOTE);
        await tx.query(
          `INSERT INTO agente.produtos (id, doc, atualizado_em)
           SELECT p->>'id', p, now() FROM jsonb_array_elements($1::jsonb) AS p
           ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, atualizado_em = now()
           WHERE agente.produtos.doc IS DISTINCT FROM EXCLUDED.doc`,
          [jsonb(lote)]
        );
      }
      await tx.query(
        `INSERT INTO agente.catalogo_estado (id, versao, sincronizado_em, completo) VALUES (1, $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET versao = EXCLUDED.versao, sincronizado_em = EXCLUDED.sincronizado_em, completo = EXCLUDED.completo`,
        [indice.versao, indice.sincronizado_em, indice.completo]
      );
    });
  }
}
