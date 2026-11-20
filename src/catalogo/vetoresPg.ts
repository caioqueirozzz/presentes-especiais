import { jsonb, type Banco } from "../db/banco.js";
import { montarConjunto, type ConjuntoVetores, type VectorStore } from "./vetores.js";
import { tabelaTiposVazia, VERSAO_TIPOS, type TabelaTipos, type TipoStore } from "./tipos.js";

const LOTE = 200;
const CINCO_MIN_MS = 5 * 60_000;

/**
 * A busca chama `carregar()` a cada pergunta (spec §9): aqui só se vai ao banco para
 * conferir uma assinatura barata, no máximo a cada 5 min, e só se relê o conjunto se ela mudou.
 */
class CacheAssinado<T> {
  private valor: T | undefined;
  private carregado = false;
  private assinatura = "";
  private conferidoEm = 0;

  constructor(
    private readonly assinar: () => Promise<string>,
    private readonly ler: () => Promise<T>,
    private readonly agora: () => number
  ) {}

  async obter(): Promise<T> {
    if (this.carregado && this.agora() - this.conferidoEm < CINCO_MIN_MS) return this.valor as T;
    try {
      const sig = await this.assinar();
      if (!this.carregado || sig !== this.assinatura) {
        this.valor = await this.ler();
        this.assinatura = sig;
        this.carregado = true;
      }
    } catch (err) {
      // Banco fora do ar com o conjunto já em memória: serve o que tem em vez de derrubar a busca.
      if (!this.carregado) throw err;
    }
    this.conferidoEm = this.agora();
    return this.valor as T;
  }

  /** Depois do próprio `salvar`: relê já, sem esperar os 5 min. */
  async renovar(): Promise<void> {
    this.carregado = false;
    await this.obter();
  }
}

const paraTexto = (v: Float32Array): string => `[${Array.from(v).join(",")}]`;

export class PgTipoStore implements TipoStore {
  private readonly cache: CacheAssinado<TabelaTipos>;

  constructor(private readonly banco: Banco, agora: () => number = Date.now) {
    this.cache = new CacheAssinado(
      async () => {
        const [r] = await this.banco.query<{ s: string | null }>(
          "SELECT md5(coalesce(string_agg(produto_id || '|' || tipo || '|' || atualizado_em, ',' ORDER BY produto_id), '')) AS s FROM agente.tipos_produto"
        );
        return r?.s ?? "";
      },
      async () => {
        const linhas = await this.banco.query<{ produto_id: string; tipo: string; atualizado_em: string }>(
          "SELECT produto_id, tipo, atualizado_em FROM agente.tipos_produto ORDER BY produto_id"
        );
        const tabela = tabelaTiposVazia();
        for (const l of linhas) tabela.produtos[l.produto_id] = { tipo: l.tipo, atualizado_em: l.atualizado_em };
        return tabela;
      },
      agora
    );
  }

  carregar(): Promise<TabelaTipos> {
    return this.cache.obter();
  }

  async salvar(tabela: TabelaTipos): Promise<void> {
    if (tabela.versao !== VERSAO_TIPOS) throw new Error("tabela de tipos de outra versão: recusada");
    const entradas = Object.entries(tabela.produtos);
    await this.banco.transacao(async (tx) => {
      await tx.query("DELETE FROM agente.tipos_produto WHERE NOT (produto_id = ANY($1::text[]))", [entradas.map(([id]) => id)]);
      for (let i = 0; i < entradas.length; i += LOTE * 5) {
        const lote = entradas.slice(i, i + LOTE * 5).map(([id, t]) => ({ id, tipo: t.tipo, atualizado_em: t.atualizado_em }));
        await tx.query(
          `INSERT INTO agente.tipos_produto (produto_id, tipo, atualizado_em)
           SELECT r->>'id', r->>'tipo', r->>'atualizado_em' FROM jsonb_array_elements($1::jsonb) AS r
           ON CONFLICT (produto_id) DO UPDATE SET tipo = EXCLUDED.tipo, atualizado_em = EXCLUDED.atualizado_em`,
          [jsonb(lote)]
        );
      }
    });
    await this.cache.renovar();
  }
}

/** Vetores de produto (`agente.vetores_produto`) ou de tipo (`agente.vetores_tipo`): mesmo formato, outra chave. */
export class PgVectorStore implements VectorStore {
  private readonly cache: CacheAssinado<ConjuntoVetores | null>;
  private readonly tabela: string;
  private readonly chave: string;

  constructor(private readonly banco: Banco, private readonly qual: "produto" | "tipo", agora: () => number = Date.now) {
    this.tabela = qual === "produto" ? "agente.vetores_produto" : "agente.vetores_tipo";
    this.chave = qual === "produto" ? "produto_id" : "tipo";
    // vetores_tipo não tem `atualizado_em`: a origem do tipo é o próprio texto dele.
    const origem = qual === "produto" ? "atualizado_em" : "tipo";
    this.cache = new CacheAssinado(
      async () => {
        const [r] = await this.banco.query<{ s: string }>(
          `SELECT md5(coalesce(string_agg(${this.chave} || '|' || modelo || '|' || ${origem}, ',' ORDER BY ${this.chave}), '')) AS s FROM ${this.tabela}`
        );
        return r?.s ?? "";
      },
      async () => {
        const linhas = await this.banco.query<{ id: string; vetor: string; modelo: string; origem: string }>(
          `SELECT ${this.chave} AS id, vetor::text AS vetor, modelo, ${origem} AS origem FROM ${this.tabela} ORDER BY ${this.chave}`
        );
        if (linhas.length === 0) return null;
        const dimensao = linhas[0].vetor.split(",").length;
        const matriz = new Float32Array(linhas.length * dimensao);
        const origens: Record<string, string> = {};
        linhas.forEach((l, i) => {
          matriz.set(l.vetor.slice(1, -1).split(",").map(Number), i * dimensao);
          origens[l.id] = l.origem;
        });
        let geradoEm = "";
        if (qual === "produto") {
          const [m] = await this.banco.query<{ t: string | null }>("SELECT max(atualizado_em) AS t FROM agente.vetores_produto");
          geradoEm = m?.t ?? "";
        }
        return montarConjunto({ modelo: linhas[0].modelo, dimensao, gerado_em: geradoEm, ids: linhas.map((l) => l.id), origem: origens, matriz });
      },
      agora
    );
  }

  carregar(): Promise<ConjuntoVetores | null> {
    return this.cache.obter();
  }

  async salvar(c: Omit<ConjuntoVetores, "linhaDe">): Promise<void> {
    await this.banco.transacao(async (tx) => {
      await tx.query(`DELETE FROM ${this.tabela} WHERE NOT (${this.chave} = ANY($1::text[]))`, [c.ids]);
      for (let i = 0; i < c.ids.length; i += LOTE) {
        const lote = c.ids.slice(i, i + LOTE).map((id, k) => ({
          id,
          vetor: paraTexto(c.matriz.subarray((i + k) * c.dimensao, (i + k + 1) * c.dimensao)),
          origem: c.origem[id] ?? "",
        }));
        const sql =
          this.qual === "produto"
            ? `INSERT INTO agente.vetores_produto (produto_id, vetor, modelo, atualizado_em)
               SELECT r->>'id', (r->>'vetor')::vector, $2, r->>'origem' FROM jsonb_array_elements($1::jsonb) AS r
               ON CONFLICT (produto_id) DO UPDATE SET vetor = EXCLUDED.vetor, modelo = EXCLUDED.modelo, atualizado_em = EXCLUDED.atualizado_em`
            : `INSERT INTO agente.vetores_tipo (tipo, vetor, modelo)
               SELECT r->>'id', (r->>'vetor')::vector, $2 FROM jsonb_array_elements($1::jsonb) AS r
               ON CONFLICT (tipo) DO UPDATE SET vetor = EXCLUDED.vetor, modelo = EXCLUDED.modelo`;
        await tx.query(sql, [jsonb(lote), c.modelo]);
      }
    });
    await this.cache.renovar();
  }
}
