/**
 * Preço de VENDA (o do site presentesespeciais.com.br). A API oficial só tem o custo; esta é a rota que a
 * vitrine chama, fora da documentação da brinde.me. Não existe rota oficial de preço de venda.
 */
import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker.js";
import { FileApiLogger, MemoryApiLogger, sanitizeUrl, type ApiLogger } from "./apiLogger.js";
import { config } from "../../config.js";

export const ROTA_VITRINE = "https://app3.brinde.me";
export const DOMINIO_LOJA = "presentesespeciais.com.br";
const MAX_QUANTIDADES_POR_CHAMADA = 60;
const TIMEOUT_MS = 5_000;
const RETRY_AFTER_PADRAO_MS = 10_000;
const TENTATIVAS_429 = 3;
const TENTATIVAS_REDE = 1;

export type MotivoErroPreco = "timeout" | "rede" | "limite" | "formato" | "indisponivel";

export class ErroPrecoVenda extends Error {
  readonly status?: number;
  readonly esperaMs?: number;
  constructor(public readonly motivo: MotivoErroPreco, mensagem: string, extras: { status?: number; esperaMs?: number } = {}) {
    super(mensagem);
    this.name = "ErroPrecoVenda";
    this.status = extras.status;
    this.esperaMs = extras.esperaMs;
  }
}

export interface OpcoesPrecoVenda {
  baseUrl?: string;
  dominio?: string;
  timeoutMs?: number;
  apiLogger?: ApiLogger;
  disjuntor?: CircuitBreaker;
  /** Injetáveis para teste. */
  fetch?: typeof fetch;
  dormir?: (ms: number) => Promise<void>;
  agora?: () => number;
}

/** 404 (id inativo) e 429 (ritmo, já tratado pelo Retry-After): a rota respondeu, não caiu. */
const contaComoFalha = (err: unknown): boolean => !(err instanceof ErroPrecoVenda && (err.status === 404 || err.status === 429));

/** `{"prices":{"10":4241}}`: toda quantidade pedida precisa vir com um inteiro ≥ 0. */
export function lerPrecos(texto: string, quantidades: number[]): Map<number, number> | null {
  let corpo: unknown;
  try {
    corpo = JSON.parse(texto);
  } catch {
    return null;
  }
  const prices = (corpo as { prices?: unknown } | null)?.prices;
  if (!prices || typeof prices !== "object") return null;
  const mapa = new Map<number, number>();
  for (const q of quantidades) {
    const v = (prices as Record<string, unknown>)[String(q)];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return null;
    mapa.set(q, v);
  }
  return mapa;
}

function segundosDoRetryAfter(valor: string | null): number | undefined {
  const s = Number(valor ?? "");
  return valor && Number.isFinite(s) && s >= 0 ? s * 1000 : undefined;
}

export class PrecoVendaHttp {
  readonly disjuntor: CircuitBreaker;
  private readonly baseUrl: string;
  private readonly dominio: string;
  private readonly timeoutMs: number;
  private readonly apiLogger: ApiLogger;
  private readonly buscar: typeof fetch;
  private readonly dormir: (ms: number) => Promise<void>;

  constructor(o: OpcoesPrecoVenda = {}) {
    this.baseUrl = (o.baseUrl ?? ROTA_VITRINE).replace(/\/+$/, "");
    this.dominio = o.dominio ?? DOMINIO_LOJA;
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
    this.apiLogger = o.apiLogger ?? (config.brindeMe.logarChamadas ? new FileApiLogger() : new MemoryApiLogger());
    this.disjuntor =
      o.disjuntor ?? new CircuitBreaker({ limiteFalhas: 5, cooldownMs: 2 * 60_000, contaComoFalha, agora: o.agora });
    // Resolvido na chamada: os testes trocam o fetch global depois de criar o cliente.
    this.buscar = o.fetch ?? ((url, init) => fetch(url, init));
    this.dormir = o.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Centavos por unidade, por quantidade. 0 = "a consultar" no site. */
  async consultar(subprodutoId: string, quantidades: number[]): Promise<Map<number, number>> {
    const unicas = [...new Set(quantidades)].sort((a, b) => a - b);
    const resultado = new Map<number, number>();
    for (let i = 0; i < unicas.length; i += MAX_QUANTIDADES_POR_CHAMADA) {
      const lote = unicas.slice(i, i + MAX_QUANTIDADES_POR_CHAMADA);
      for (const [q, c] of await this.lote(subprodutoId, lote)) resultado.set(q, c);
    }
    return resultado;
  }

  private async lote(subprodutoId: string, quantidades: number[]): Promise<Map<number, number>> {
    try {
      this.disjuntor.verificar();
    } catch (err) {
      if (err instanceof CircuitOpenError) throw new ErroPrecoVenda("indisponivel", err.message);
      throw err;
    }
    const url = `${this.baseUrl}/api/subproduct/${encodeURIComponent(subprodutoId)}/price/${quantidades.join(",")}?domain=${encodeURIComponent(this.dominio)}`;
    let rede = 0;
    let limite = 0;
    for (let tentativa = 0; ; tentativa++) {
      try {
        const precos = await this.uma(url, quantidades, tentativa);
        this.disjuntor.registrarSucesso();
        return precos;
      } catch (err) {
        this.disjuntor.registrarFalha(err);
        if (!(err instanceof ErroPrecoVenda) || this.disjuntor.estado === "aberto") throw err;
        if (err.motivo === "rede" && rede++ < TENTATIVAS_REDE) continue;
        if (err.motivo === "limite" && limite++ < TENTATIVAS_429) {
          await this.dormir(err.esperaMs ?? RETRY_AFTER_PADRAO_MS);
          continue;
        }
        throw err;
      }
    }
  }

  private async uma(url: string, quantidades: number[], tentativa: number): Promise<Map<number, number>> {
    const inicio = Date.now();
    const registrar = (status?: number, error?: string) =>
      this.apiLogger.log({
        method: "GET",
        path: sanitizeUrl(url),
        status,
        duration_ms: Date.now() - inicio,
        attempt: tentativa,
        error,
        circuito: this.disjuntor.estado,
      });

    let resposta: Response;
    let texto: string;
    try {
      resposta = await this.buscar(url, {
        headers: { Accept: "application/json", domain: this.dominio },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // O timeout também aborta a leitura do corpo.
      texto = await resposta.text();
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      registrar(undefined, timeout ? "timeout" : "rede");
      throw new ErroPrecoVenda(timeout ? "timeout" : "rede", timeout ? `sem resposta em ${this.timeoutMs}ms` : "falha de conexão com a vitrine");
    }

    if (resposta.status === 429) {
      registrar(429, "limite");
      throw new ErroPrecoVenda("limite", "HTTP 429", { status: 429, esperaMs: segundosDoRetryAfter(resposta.headers.get("retry-after")) });
    }
    if (resposta.status >= 500) {
      registrar(resposta.status, "rede");
      throw new ErroPrecoVenda("rede", `HTTP ${resposta.status}`, { status: resposta.status });
    }
    if (!resposta.ok) {
      registrar(resposta.status, "formato");
      throw new ErroPrecoVenda("formato", `HTTP ${resposta.status}`, { status: resposta.status });
    }
    const precos = lerPrecos(texto, quantidades);
    if (!precos) {
      registrar(resposta.status, "formato");
      throw new ErroPrecoVenda("formato", "resposta fora do formato {prices:{...}}", { status: resposta.status });
    }
    registrar(resposta.status);
    return precos;
  }
}
