/**
 * O produto sai com o preço de VENDA (o do site) em `prices`, e o custo da API é descartado aqui, na entrada
 * (spec da Fase 0, 5.3). Uma consulta à vitrine por grupo de cores com as mesmas faixas de custo.
 */
import type {
  BrindeMeClient,
  CreateBudgetOptions,
  ListOrdersParams,
  ListProductsParams,
  OrderListResponse,
} from "./client.js";
import type { Admin, Budget, CreateBudgetBody, Order, PriceRange, Product, ProductListResponse, Subproduct } from "./types.js";
import { logarFalhaDeCotacao } from "../../catalogo/logPrecos.js";
import { chaveDoGrupo, idsDeGrupo, limitesDe, montarFaixasDeVenda, pontosDeConsulta } from "../../catalogo/faixasDeVenda.js";

export type ConsultaPreco = (subprodutoId: string, quantidades: number[]) => Promise<Map<number, number>>;

export async function comPrecoDeVenda(p: Product, consultar: ConsultaPreco): Promise<Product> {
  const minimo = Math.max(1, p.min_quantity);
  const grupos = new Map<string, Subproduct[]>();
  for (const s of p.subproducts) {
    if (!s.status) continue;
    const chave = chaveDoGrupo(s.prices);
    grupos.set(chave, [...(grupos.get(chave) ?? []), s]);
  }

  const ativas = p.subproducts.filter((s) => s.status);
  const ids = idsDeGrupo(ativas.map((s) => chaveDoGrupo(s.prices)));
  const idDe = new Map(ativas.map((s, i) => [s.id, ids[i]]));

  const venda = new Map<string, { prices: PriceRange[]; indisponivel: boolean }>();
  await Promise.all(
    [...grupos].map(async ([chave, cores]) => {
      const limites = limitesDe(cores[0].prices);
      if (limites.length === 0) {
        venda.set(chave, { prices: [], indisponivel: false });
        return;
      }
      try {
        const precos = await consultar(cores[0].id, pontosDeConsulta(limites, minimo));
        venda.set(chave, { prices: montarFaixasDeVenda(limites, minimo, precos), indisponivel: false });
      } catch (err) {
        logarFalhaDeCotacao({ produto_id: p.id, subproduto_id: cores[0].id, motivo: err instanceof Error ? err.message : String(err) });
        venda.set(chave, { prices: [], indisponivel: true });
      }
    })
  );

  return {
    ...p,
    subproducts: p.subproducts.map((s) => {
      const limites = limitesDe(s.prices);
      if (!s.status) return { ...s, prices: [], limites };
      const chave = chaveDoGrupo(s.prices);
      const v = venda.get(chave)!;
      return {
        ...s,
        prices: v.prices,
        limites,
        grupo_preco: idDe.get(s.id),
        ...(v.indisponivel ? { preco_indisponivel: true } : {}),
      };
    }),
  };
}

export class ClienteComPrecoDeVenda implements BrindeMeClient {
  constructor(private readonly dentro: BrindeMeClient) {}

  async getProduct(id: string): Promise<Product> {
    return comPrecoDeVenda(await this.dentro.getProduct(id), (sid, qs) => this.dentro.precoVenda(sid, qs));
  }

  precoVenda(subprodutoId: string, quantidades: number[]): Promise<Map<number, number>> {
    return this.dentro.precoVenda(subprodutoId, quantidades);
  }

  listProducts(params?: ListProductsParams): Promise<ProductListResponse> {
    return this.dentro.listProducts(params);
  }

  createBudget(body: CreateBudgetBody, options?: CreateBudgetOptions): Promise<Budget> {
    return this.dentro.createBudget(body, options);
  }

  getBudget(id: string): Promise<Budget> {
    return this.dentro.getBudget(id);
  }

  getOrder(id: string): Promise<Order> {
    return this.dentro.getOrder(id);
  }

  listOrders(params?: ListOrdersParams): Promise<OrderListResponse> {
    return this.dentro.listOrders(params);
  }

  listAdmins(): Promise<Admin[]> {
    return this.dentro.listAdmins();
  }
}
