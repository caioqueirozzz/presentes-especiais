/**
 * Sync de preços de venda (spec da Fase 0, 5.7): reconsulta o site para cada grupo de cores do índice, nos pontos
 * dos limites guardados. Não chama a API oficial. Mais de 5% de grupos com falha: não grava nada.
 */
import type { ConsultaPreco } from "../integrations/brindeme/clienteComPrecoDeVenda.js";
import { chaveDoGrupo, idsDeGrupo, limitesDe, montarFaixasDeVenda, pontosDeConsulta } from "./faixasDeVenda.js";
import {
  VERSAO_INDICE,
  type FaixaPreco,
  type IndiceCatalogo,
  type ProductIndexStore,
  type ProdutoIndexado,
  type SubprodutoIndexado,
} from "./indice.js";

export const FRACAO_MAXIMA_DE_FALHAS = 0.05;

export interface OpcoesSyncPrecos {
  concorrencia?: number;
  agora?: Date;
  onProgresso?(feitos: number, total: number): void;
}

export interface FalhaSyncPrecos {
  produto_id: string;
  grupo_preco: string;
  erro: string;
}

export interface ResultadoSyncPrecos {
  grupos: number;
  atualizados: number;
  falhas: FalhaSyncPrecos[];
  gravou: boolean;
}

function gruposDe(produtos: ProdutoIndexado[]): Array<{ produto: ProdutoIndexado; chave: string; subs: SubprodutoIndexado[] }> {
  const grupos: Array<{ produto: ProdutoIndexado; chave: string; subs: SubprodutoIndexado[] }> = [];
  for (const produto of produtos) {
    const porChave = new Map<string, SubprodutoIndexado[]>();
    for (const s of produto.subprodutos) {
      const chave = s.grupo_preco || s.id;
      porChave.set(chave, [...(porChave.get(chave) ?? []), s]);
    }
    for (const [chave, subs] of porChave) grupos.push({ produto, chave, subs });
  }
  return grupos;
}

/** Recalcula as faixas de venda sobre uma cópia do índice. Não grava. */
export async function recalcularPrecos(
  indice: IndiceCatalogo,
  consultar: ConsultaPreco,
  opcoes: OpcoesSyncPrecos = {}
): Promise<{ indice: IndiceCatalogo; grupos: number; atualizados: number; falhas: FalhaSyncPrecos[] }> {
  const agora = (opcoes.agora ?? new Date()).toISOString();
  const produtos = structuredClone(indice.produtos);
  const grupos = gruposDe(produtos);
  const falhas: FalhaSyncPrecos[] = [];
  let atualizados = 0;
  let proximo = 0;
  let feitos = 0;
  async function trabalhador(): Promise<void> {
    while (proximo < grupos.length) {
      const g = grupos[proximo++];
      const limites = g.subs[0].limites ?? [];
      const minimo = g.produto.quantidade_minima;
      try {
        const faixas: FaixaPreco[] =
          limites.length === 0
            ? []
            : montarFaixasDeVenda(limites, minimo, await consultar(g.subs[0].id, pontosDeConsulta(limites, minimo))).map((f) => ({ min: f.min, max: f.max, preco: f.price }));
        for (const s of g.subs) {
          s.faixas = faixas;
          s.faixas_venda_em = agora;
        }
        atualizados++;
      } catch (err) {
        falhas.push({ produto_id: g.produto.id, grupo_preco: g.chave, erro: err instanceof Error ? err.message : String(err) });
      }
      opcoes.onProgresso?.(++feitos, grupos.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, opcoes.concorrencia ?? 3), grupos.length) }, trabalhador));
  return { indice: { ...indice, versao: VERSAO_INDICE, produtos }, grupos: grupos.length, atualizados, falhas };
}

/** Aplica as faixas novas sobre o índice ATUAL: produto que entrou ou saiu durante o sync continua como está. */
function aplicar(atual: IndiceCatalogo, novo: IndiceCatalogo): IndiceCatalogo {
  const novos = new Map(novo.produtos.flatMap((p) => p.subprodutos.map((s) => [s.id, s] as const)));
  return {
    ...atual,
    produtos: atual.produtos.map((p) => ({
      ...p,
      subprodutos: p.subprodutos.map((s) => {
        const n = novos.get(s.id);
        const maisNovo = n?.faixas_venda_em && n.faixas_venda_em > (s.faixas_venda_em ?? "");
        return n && maisNovo && (n.grupo_preco ?? "") === (s.grupo_preco ?? "") ? { ...s, faixas: n.faixas, faixas_venda_em: n.faixas_venda_em } : s;
      }),
    })),
  };
}

export async function sincronizarPrecos(store: ProductIndexStore, consultar: ConsultaPreco, opcoes: OpcoesSyncPrecos = {}): Promise<ResultadoSyncPrecos> {
  const r = await recalcularPrecos(store.carregar(), consultar, opcoes);
  const gravou = r.grupos > 0 && r.falhas.length / r.grupos <= FRACAO_MAXIMA_DE_FALHAS;
  if (gravou) store.salvar(aplicar(store.carregar(), r.indice));
  return { grupos: r.grupos, atualizados: r.atualizados, falhas: r.falhas, gravou };
}

interface IndiceV1 {
  sincronizado_em: string;
  completo: boolean;
  produtos: Array<Omit<ProdutoIndexado, "subprodutos"> & { subprodutos: Array<{ id: string; sku: string; cor: string; estoque: number; faixas: FaixaPreco[] }> }>;
}

/** v1 (faixas de custo) → v2 sem custo: só limites e grupo; as faixas de venda vêm de recalcularPrecos. */
export function esqueletoV2(v1: IndiceV1): IndiceCatalogo {
  return {
    versao: VERSAO_INDICE,
    sincronizado_em: v1.sincronizado_em,
    completo: v1.completo,
    produtos: v1.produtos.map((p) => {
      const custos = p.subprodutos.map((s) => s.faixas.map((f) => ({ min: f.min, max: f.max, price: f.preco })));
      const ids = idsDeGrupo(custos.map(chaveDoGrupo));
      return {
        ...p,
        subprodutos: p.subprodutos.map((s, i) => ({ id: s.id, sku: s.sku, cor: s.cor, estoque: s.estoque, faixas: [], limites: limitesDe(custos[i]), grupo_preco: ids[i], faixas_venda_em: "" })),
      };
    }),
  };
}
