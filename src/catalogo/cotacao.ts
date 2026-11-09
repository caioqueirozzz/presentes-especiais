/**
 * Cotação exata ao vivo: todo preço que chega ao cliente sai daqui, por cor e por quantidade (spec da Fase 0,
 * seção 2). O índice e os grupos de cor só buscam, filtram e ordenam.
 */
import type { BrindeMeClient } from "../integrations/brindeme/client.js";
import { ErroPrecoVenda, type MotivoErroPreco } from "../integrations/brindeme/precoVenda.js";
import type { ConversationState } from "../agent/state.js";

export const MAX_CORES_COTADAS = 6;
export const VALIDADE_COTACAO_MS = 60 * 60 * 1000;
const EM_PARALELO = 6;

export interface Cotacao {
  subproduto_id: string;
  quantidade: number;
  /** Centavos por unidade; 0 = "a consultar" no site. */
  centavos: number;
  /** Próximo degrau mais barato, conferido na mesma chamada. */
  proximo?: { quantidade: number; centavos: number };
  fonte: "site";
  em: string;
}

export interface FalhaCotacao {
  subproduto_id: string;
  quantidade: number;
  erro: MotivoErroPreco;
}

export type ResultadoCotacao = Cotacao | FalhaCotacao;

export const cotou = (r: ResultadoCotacao): r is Cotacao => "centavos" in r;

export interface ItemCotacao {
  subprodutoId: string;
  quantidade: number;
  proximoDegrau?: number;
}

export async function cotarAoVivo(
  client: Pick<BrindeMeClient, "precoVenda">,
  itens: ItemCotacao[],
  agora: () => Date = () => new Date()
): Promise<ResultadoCotacao[]> {
  const resultados: ResultadoCotacao[] = new Array(itens.length);
  let proximo = 0;
  async function trabalhador(): Promise<void> {
    while (proximo < itens.length) {
      const i = proximo++;
      const { subprodutoId, quantidade, proximoDegrau } = itens[i];
      try {
        const precos = await client.precoVenda(subprodutoId, proximoDegrau ? [quantidade, proximoDegrau] : [quantidade]);
        const centavos = precos.get(quantidade) ?? 0;
        const doDegrau = proximoDegrau ? (precos.get(proximoDegrau) ?? 0) : 0;
        const maisBarato = proximoDegrau !== undefined && doDegrau > 0 && centavos > 0 && doDegrau < centavos;
        resultados[i] = {
          subproduto_id: subprodutoId,
          quantidade,
          centavos,
          ...(maisBarato ? { proximo: { quantidade: proximoDegrau!, centavos: doDegrau } } : {}),
          fonte: "site",
          em: agora().toISOString(),
        };
      } catch (err) {
        resultados[i] = { subproduto_id: subprodutoId, quantidade, erro: err instanceof ErroPrecoVenda ? err.motivo : "indisponivel" };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EM_PARALELO, itens.length) }, trabalhador));
  return resultados;
}

const chave = (subprodutoId: string, quantidade: number) => `${subprodutoId}:${quantidade}`;

/** Guarda as cotações que vieram e descarta as vencidas (o estado vai para o disco e para o CRM). */
export function guardarCotacoes(state: ConversationState, resultados: ResultadoCotacao[], agora = new Date()): void {
  const guardadas = Object.fromEntries(
    Object.entries(state.cotacoes ?? {}).filter(([, c]) => agora.getTime() - Date.parse(c.em) < VALIDADE_COTACAO_MS)
  );
  for (const r of resultados) if (cotou(r)) guardadas[chave(r.subproduto_id, r.quantidade)] = r;
  state.cotacoes = guardadas;
}

/** Mesma cor, mesma quantidade, fonte site e menos de 1 h: senão, cota de novo. */
export function cotacaoValida(
  state: ConversationState,
  subprodutoId: string,
  quantidade: number,
  agora = new Date()
): Cotacao | undefined {
  const c = state.cotacoes?.[chave(subprodutoId, quantidade)];
  if (!c || c.fonte !== "site" || agora.getTime() - Date.parse(c.em) >= VALIDADE_COTACAO_MS) return undefined;
  return c;
}
