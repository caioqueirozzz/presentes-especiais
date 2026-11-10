import { jsonb, type Banco } from "../db/banco.js";
import { indiceVazio, VERSAO_INDICE, type IndiceCatalogo, type ProdutoIndexado } from "./indice.js";

const LOTE = 500;

/** Catálogo no banco. A busca não lê daqui a cada pergunta: carrega na partida e depois do sync. */
export class PgProductIndexStore {
  constructor(private readonly banco: Banco) {}

  async carregar(): Promise<IndiceCatalogo> {
    const [estado] = await this.banco.query<{ versao: number; sincronizado_em: string; completo: boolean }>(
      "SELECT versao, sincronizado_em, completo FROM agente.catalogo_estado WHERE id = 1"
    );
    if (!estado || estado.versao !== VERSAO_INDICE) return indiceVazio();
    const linhas = await this.banco.query<{ doc: ProdutoIndexado }>("SELECT doc FROM agente.produtos ORDER BY id");
    return { versao: estado.versao, sincronizado_em: estado.sincronizado_em, completo: estado.completo, produtos: linhas.map((l) => l.doc) };
  }

  async sincronizadoEm(): Promise<string> {
    const [estado] = await this.banco.query<{ sincronizado_em: string }>("SELECT sincronizado_em FROM agente.catalogo_estado WHERE id = 1");
    return estado?.sincronizado_em ?? "";
  }

  async salvar(indice: IndiceCatalogo): Promise<void> {
    await this.banco.transacao(async (tx) => {
      const ids = indice.produtos.map((p) => p.id);
      await tx.query("DELETE FROM agente.produtos WHERE NOT (id = ANY($1::text[]))", [ids]);
      for (let i = 0; i < indice.produtos.length; i += LOTE) {
        const lote = indice.produtos.slice(i, i + LOTE);
        await tx.query(
          `INSERT INTO agente.produtos (id, doc, atualizado_em)
           SELECT p->>'id', p, now() FROM jsonb_array_elements($1::jsonb) AS p
           ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, atualizado_em = now()`,
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
