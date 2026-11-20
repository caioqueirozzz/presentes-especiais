# Fase 0 — Preço de venda do site no agente: plano de implementação

> **Para quem vai executar:** sub-skill obrigatória: superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans, tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** todo preço que chega ao cliente passa a ser o preço do site (a rota `app3` da vitrine), exato por cor e por quantidade. O custo da API oficial é descartado na entrada.

**Arquitetura:** o `HttpBrindeMeClient` ganha `precoVenda()`, que chama a rota da vitrine. Um embrulho (`ClienteComPrecoDeVenda`) troca o custo pelas faixas de venda em `getProduct`, com uma consulta por grupo de cores, e o índice local passa para a v2, já com o preço de venda. Busca, detalhe e orçamento fazem uma **cotação exata ao vivo** por cor e montam um **cartão** (foto + legenda). O runtime envia os cartões como foto antes do texto do modelo. Um `sync:precos` noturno mantém o índice.

**Stack:** Node 20, TypeScript (`tsx`), zod, vitest 2, whatsapp-web.js fixado em `064a3d5`, OpenAI `gpt-4o-mini` nos evals.

**Spec:** `docs/superpowers/specs/2026-11-05-fase-0-preco-de-venda-design.md` (commits `f200ae3` e `586ecc6`). Leia a spec inteira antes da Tarefa 1. Este plano argumenta a partir dela.

---

## Para quem chega sem contexto

- **Repo:** `C:\Users\joao_\dev\DC Tech\Presentes Especiais\repo-agente-brindeme` (GitHub `caioqueirozzz/presentes-especiais`, **repo público**).
- **Branch de partida:** `preco-de-venda-do-site`, sobre `restaura-correcoes-do-dogfooding`. Trabalhe nela; não crie outra.
- **Idioma:** código, nomes, comentários, mensagens e commits em português, no estilo do código vizinho.
- **Shell:** Windows. Os comandos abaixo valem no Git Bash. Testes sempre com `--maxWorkers=1 --minWorkers=1` (PC com 7,8 GB de RAM; o vitest 2.1.9 exige os dois juntos).
- **Fronteiras duras:**
  - **Não faça push nem abra PR.** Commit local por tarefa, sim. O João revisa e decide o push.
  - **Nunca rode `npm run sync:pedidos`** (grava dados pessoais) nem o `sync:catalogo` completo (~3,6 h).
  - **Nunca copie credenciais** do `.env` nem da descrição de tasks do ClickUp para arquivo, commit ou log. Telefone não entra em issue (repo público).
  - Não mexa na Fase 5 (infra) nem em `ORCAMENTO_ESCRITA=simulada` (o orçamento é emitido por uma pessoa: requisito R5).
  - Comentário só para o porquê que o código não mostra, em uma linha. O raciocínio vai no commit.
- **Tarefas 0, 16 e 17** precisam de `OPENAI_API_KEY` e, na 17, do `.env` real (`BRINDEME_MODE=http`). Se você não tiver isso, pare nelas e deixe para o João; não invente resultado.

## Restrições globais (valem para todas as tarefas)

- Fonte do preço de venda: `GET https://app3.brinde.me/api/subproduct/{subproduto_id}/price/{q1,q2,...}?domain=presentesespeciais.com.br` com o cabeçalho `domain: presentesespeciais.com.br`. Resposta `{"prices":{"10":4241}}`, em centavos por unidade, e `0` = "a consultar". Não existe rota oficial.
- No máximo 60 quantidades por chamada. Timeout de 5 s. Erro de rede ou 5xx: 1 nova tentativa. 429: espera o `Retry-After` (padrão de 10 s), até 3 vezes. Disjuntor próprio: abre com 5 falhas seguidas, por 2 min.
- **O custo nunca é gravado, mostrado nem usado em conta.** Ele serve só de chave de grupo, em memória.
- **Preço mostrado ao cliente vem só da cotação exata** (`fonte: "site"`, válida por 1 h, por cor e por quantidade). O índice e os grupos servem só para buscar, filtrar e ordenar.
- Sem preço exato: o produto aparece "Valor a confirmar com a equipe.", e `preparar_orcamento` manda transferir.
- Condição para mais unidades: só o próximo degrau mais barato, no texto "A partir de N un.: R$ X/un". Sem degrau mais barato: "Para quantidades maiores, a equipe faz uma condição especial."
- Legenda do cartão: nome, cores, preço e condição. **Sem SKU e sem quantidade mínima.**
- Sob demanda: só `afc89ae2-d187-405a-b826-d2e2ae0447f5` (Camisa Dray Fit) e `dd4c5dbf-ab7d-4084-8c2b-e2f7e28669de` (Caneca Mágica). Estoque ignorado; vale qualquer quantidade a partir do mínimo.
- Até 3 produtos por busca e até 6 cores cotadas por produto (`MAX_CORES_COTADAS = 6`). Cotação em paralelo, no máximo 6 de cada vez.
- `VERSAO_INDICE = 2`.
- Sync de preços: mais de 5% de grupos com falha → não grava nada e sai com 1.
- Produção é o padrão. Só `AMBIENTE=dev` relaxa a verificação. `BRINDEME_MODE` não tem padrão.

## Foco da revisão

Cinco situações que a spec implica e que os testes das tarefas não cobririam sozinhos, a mais provável primeiro. Cada uma ganhou um teste na tarefa dona do código.

1. **O eco da foto que a Lia mandou** tem de ser reconhecido como da Lia. Se não for, vira "atendente assumiu" e a conversa passa para modo humano. Esperado: o eco chega com a legenda no corpo e casa com o registro de saída. (Teste na Tarefa 13. No WhatsApp real, isto só se prova no dogfooding: veja o checklist da Tarefa 18.)
2. **Imagem ausente ou URL inválida** num produto: o item de imagem não pode quebrar o `respostaMensagensSchema.parse` da ponte, porque isso derrubaria o turno inteiro. Esperado: o cartão vai como texto. (Teste na Tarefa 12.)
3. **Índice v1 no disco depois da troca de código:** ele carrega vazio. Esperado: o agente se recusa a subir com a mensagem de índice vazio, e `sync:precos` sem `--migrar` explica que é preciso migrar. (Teste na Tarefa 5 e mensagem na Tarefa 15.)
4. **Cotação que falha num produto com orçamento informado:** sem preço conhecido não dá para conferir o orçamento. Esperado: o produto continua, sem preço ("Valor a confirmar com a equipe."), e não é descartado como "acima do orçamento". (Teste na Tarefa 9.)
5. **`detalhar_produto` com quantidade abaixo do mínimo:** esperado: nenhuma cotação e nenhum preço, só o mínimo. (Teste na Tarefa 10.)

---

## Mapa de arquivos

**Novos**

| Arquivo | Responsabilidade |
|---|---|
| `src/integrations/brindeme/precoVenda.ts` | Chama a rota da vitrine: erros tipados, lotes, retry e disjuntor |
| `src/catalogo/faixasDeVenda.ts` | Funções puras: pontos de consulta, faixas de venda, próximo degrau, chave e hash do grupo |
| `src/integrations/brindeme/clienteComPrecoDeVenda.ts` | Embrulho do cliente: custo → faixas de venda, uma consulta por grupo |
| `src/catalogo/sobDemanda.ts` + `src/knowledge/sob-demanda.json` | Lista dos 2 produtos sob demanda |
| `src/catalogo/cotacao.ts` | Cotação exata ao vivo e cache em `state.cotacoes` |
| `src/catalogo/logPrecos.ts` | Log `preco_divergente` em `logs/precos.jsonl` |
| `src/tools/cartao.ts` | Legenda do cartão e conversão dos cartões em itens de resposta |
| `src/catalogo/syncPrecos.ts` + `scripts/syncPrecos.ts` | Sync de preços e migração v1 → v2 |
| `src/operacao/exigirAmbiente.ts` | Trava de partida dos processos |
| `src/operacao/conferenciaPrecos.ts` + `scripts/conferirPrecos.ts` | Critério de aceite com dado real |
| `scripts/sondarRitmoPrecos.ts` | Mede o limite de chamadas da rota `app3` |

**Alterados:** `circuitBreaker.ts`, `types.ts`, `client.ts`, `mappers.ts`, `mockClient.ts`, `httpClient.ts`, `factory.ts`, `catalogo/indice.ts`, `catalogo/oferta.ts`, `catalogo/verificacao.ts`, `catalogo/recomendar.ts`, `agent/state.ts`, `tools/buscarProdutos.ts`, `tools/detalharProduto.ts`, `tools/prepararOrcamento.ts`, `tools/index.ts`, `contrato/esquemas.ts`, `agent/runTurn.ts`, `api/agenteDefinitivo.ts`, `duble/direto.ts`, `agent/prompt/system.md`, `whatsapp/canal.ts`, `whatsapp/sessao.ts`, `whatsapp/envio.ts`, `whatsapp/ponte.ts`, `whatsapp/estadoPonte.ts`, `config.ts`, `operacao/verificacaoAmbiente.ts`, `partida.ts`, `api/index.ts`, `duble/index.ts`, `whatsapp/index.ts`, `scripts/verificarEnv.ts`, `evals/runEvals.ts`, `package.json`, `.env.example`, `README.md` e os testes indicados em cada tarefa.

**Não muda:** `crm/src/lib/ingest.ts`. O eco da foto já chega ao CRM com a legenda no corpo (`tipo: "midia"`). A URL vai junto no texto, numa segunda linha, a partir de `ponte.ts` (Tarefa 13). É uma divergência pequena da spec 6.1, para não mexer no CRM.

---

### Tarefa 0: linha de base (antes de qualquer código)

**Arquivos:** nenhum.

- [ ] **Passo 1: conferir o ponto de partida**

```bash
cd "/c/Users/joao_/dev/DC Tech/Presentes Especiais/repo-agente-brindeme"
git branch --show-current   # esperado: preco-de-venda-do-site
git status --short          # esperado: só " M .gitignore" (a linha .superpowers); não mexa nele
npm ci
npm run typecheck
npx vitest run --maxWorkers=1 --minWorkers=1
```
Esperado: typecheck limpo e todos os testes passando. Anote o total (por volta de 891). Se algo falhar aqui, pare e reporte: a falha não é sua.

- [ ] **Passo 2: evals de antes (A do A/B)**

```bash
npm run evals -- --rodadas 3 --relatorio "../Validações/evals-fase0-antes.json"
```
Esperado: o relatório gravado em `Presentes Especiais/Validações/`. Anote, por cenário, quantas rodadas passaram. Esse número é o piso da Tarefa 16. Sem `OPENAI_API_KEY`, pare e peça ao João.

---

### Tarefa 1: disjuntor configurável e a rota de preço da vitrine

**Arquivos:**
- Modificar: `src/integrations/brindeme/circuitBreaker.ts`
- Criar: `src/integrations/brindeme/precoVenda.ts`
- Teste: `tests/precoVenda.test.ts`

**Interfaces:**
- Produz: `class ErroPrecoVenda extends Error { motivo: MotivoErroPreco; status?: number; esperaMs?: number }`, `type MotivoErroPreco = "timeout" | "rede" | "limite" | "formato" | "indisponivel"`, `class PrecoVendaHttp { consultar(subprodutoId: string, quantidades: number[]): Promise<Map<number, number>>; readonly disjuntor: CircuitBreaker }`, `lerPrecos(texto, quantidades): Map<number, number> | null`, `ROTA_VITRINE` e `DOMINIO_LOJA`.
- `CircuitBreaker` ganha a opção `contaComoFalha?: (err: unknown) => boolean`.

- [ ] **Passo 1: opção `contaComoFalha` no disjuntor**

Em `circuitBreaker.ts`, renomeie a função `contaComoFalha` (linha 31) para `contaComoFalhaPadrao` e acrescente em `DisjuntorOptions`:

```ts
  /** Quais erros contam como falha; padrão: rede, 401/403/408 e 5xx. */
  contaComoFalha?: (err: unknown) => boolean;
```

Na classe, junto dos outros campos `readonly`:

```ts
  private readonly contaComoFalha: (err: unknown) => boolean;
```

No construtor, depois de `this.agora = ...`:

```ts
    this.contaComoFalha = options?.contaComoFalha ?? contaComoFalhaPadrao;
```

Em `registrarFalha`, troque `if (!contaComoFalha(err))` por `if (!this.contaComoFalha(err))`.

- [ ] **Passo 2: escrever o teste que falha** — `tests/precoVenda.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { PrecoVendaHttp, ErroPrecoVenda, lerPrecos } from "../src/integrations/brindeme/precoVenda.js";
import { MemoryApiLogger } from "../src/integrations/brindeme/apiLogger.js";

type Chamada = { url: string; headers: Record<string, string> };

/** fetch falso: cada chamada consome a próxima resposta do roteiro. */
function fetchFalso(roteiro: Array<() => Response | Promise<Response>>, chamadas: Chamada[]) {
  return (async (url: string, init?: RequestInit) => {
    chamadas.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const proxima = roteiro.shift();
    if (!proxima) throw new Error("roteiro acabou");
    return proxima();
  }) as unknown as typeof fetch;
}

const json = (corpo: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(corpo), { status, headers });

function vitrine(roteiro: Array<() => Response | Promise<Response>>, chamadas: Chamada[] = [], extra: { agora?: () => number } = {}) {
  const esperas: number[] = [];
  const v = new PrecoVendaHttp({
    fetch: fetchFalso(roteiro, chamadas),
    apiLogger: new MemoryApiLogger(),
    dormir: async (ms) => void esperas.push(ms),
    ...extra,
  });
  return { v, esperas, chamadas };
}

describe("rota de preço da vitrine (app3)", () => {
  it("200: centavos por quantidade, com o cabeçalho domain e a quantidade no caminho", async () => {
    const { v, chamadas } = vitrine([json({ prices: { "10": 4241, "25": 0 } })]);
    const r = await v.consultar("sub-1", [25, 10, 10]);
    expect([...r]).toEqual([[10, 4241], [25, 0]]);
    expect(chamadas[0].url).toBe("https://app3.brinde.me/api/subproduct/sub-1/price/10,25?domain=presentesespeciais.com.br");
    expect(chamadas[0].headers.domain).toBe("presentesespeciais.com.br");
  });

  it("0 é mantido como 0 (a consultar)", async () => {
    const { v } = vitrine([json({ prices: { "100": 0 } })]);
    expect((await v.consultar("s", [100])).get(100)).toBe(0);
  });

  it("404 em HTML é formato, com status 404, e não abre o disjuntor", async () => {
    const html = () => new Response("<html>not found</html>", { status: 404 });
    const { v } = vitrine([html, html, html, html, html, html]);
    for (let i = 0; i < 6; i++) {
      await expect(v.consultar("x", [10])).rejects.toMatchObject({ motivo: "formato", status: 404 });
    }
    expect(v.disjuntor.estado).toBe("fechado");
  });

  it("resposta que não é JSON e quantidade ausente são formato", async () => {
    const { v } = vitrine([() => new Response("ok", { status: 200 }), json({ prices: { "10": 4241 } })]);
    await expect(v.consultar("s", [10])).rejects.toMatchObject({ motivo: "formato" });
    await expect(v.consultar("s", [10, 25])).rejects.toMatchObject({ motivo: "formato" });
  });

  it("valor que não é inteiro ≥ 0 é formato (string, negativo, fração)", () => {
    expect(lerPrecos('{"prices":{"10":"4241"}}', [10])).toBeNull();
    expect(lerPrecos('{"prices":{"10":-1}}', [10])).toBeNull();
    expect(lerPrecos('{"prices":{"10":42.4}}', [10])).toBeNull();
  });

  it("429 espera o Retry-After e tenta de novo; 4 vezes 429 é limite", async () => {
    const r429 = json({}, 429, { "retry-after": "2" });
    const a = vitrine([r429, json({ prices: { "10": 1 } })]);
    expect((await a.v.consultar("s", [10])).get(10)).toBe(1);
    expect(a.esperas).toEqual([2000]);

    const b = vitrine([json({}, 429), json({}, 429), json({}, 429), json({}, 429)]);
    await expect(b.v.consultar("s", [10])).rejects.toMatchObject({ motivo: "limite" });
    expect(b.esperas).toEqual([10_000, 10_000, 10_000]);
  });

  it("5xx tenta mais uma vez; duas vezes é rede", async () => {
    const a = vitrine([json({}, 502), json({ prices: { "10": 7 } })]);
    expect((await a.v.consultar("s", [10])).get(10)).toBe(7);
    const b = vitrine([json({}, 500), json({}, 500)]);
    await expect(b.v.consultar("s", [10])).rejects.toMatchObject({ motivo: "rede" });
  });

  it("timeout vira motivo timeout", async () => {
    const { v } = vitrine([() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }))]);
    await expect(v.consultar("s", [10])).rejects.toMatchObject({ motivo: "timeout" });
  });

  it("disjuntor: 5 falhas seguidas abrem por 2 min e a chamada falha na hora com indisponivel", async () => {
    let t = 0;
    const falha = json({}, 500);
    const { v, chamadas } = vitrine([falha, falha, falha, falha, falha, json({ prices: { "10": 3 } })], [], { agora: () => t });
    for (let i = 0; i < 3; i++) await expect(v.consultar("s", [10])).rejects.toBeInstanceOf(ErroPrecoVenda);
    expect(chamadas).toHaveLength(5);
    await expect(v.consultar("s", [10])).rejects.toMatchObject({ motivo: "indisponivel" });
    expect(chamadas).toHaveLength(5);
    t += 2 * 60_000;
    expect((await v.consultar("s", [10])).get(10)).toBe(3);
  });

  it("mais de 60 quantidades vão em lotes de 60", async () => {
    const qs = Array.from({ length: 61 }, (_, i) => i + 1);
    const corpo = (de: number, ate: number) => ({ prices: Object.fromEntries(qs.slice(de, ate).map((q) => [String(q), q])) });
    const { v, chamadas } = vitrine([json(corpo(0, 60)), json(corpo(60, 61))]);
    const r = await v.consultar("s", qs);
    expect(r.size).toBe(61);
    expect(chamadas).toHaveLength(2);
  });
});
```

- [ ] **Passo 3: rodar e ver falhar**

Rode: `npx vitest run tests/precoVenda.test.ts --maxWorkers=1 --minWorkers=1`
Esperado: FAIL com "Cannot find module .../precoVenda.js".

- [ ] **Passo 4: implementar** — `src/integrations/brindeme/precoVenda.ts`

```ts
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

/** 404 é id que não existe: a rota respondeu, não caiu. */
const contaComoFalha = (err: unknown): boolean => !(err instanceof ErroPrecoVenda && err.status === 404);

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
    try {
      resposta = await this.buscar(url, {
        headers: { Accept: "application/json", domain: this.dominio },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      registrar(undefined, timeout ? "timeout" : "rede");
      throw new ErroPrecoVenda(timeout ? "timeout" : "rede", timeout ? `sem resposta em ${this.timeoutMs}ms` : "falha de conexão com a vitrine");
    }

    const texto = await resposta.text();
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
```

- [ ] **Passo 5: rodar e ver passar**

Rode: `npx vitest run tests/precoVenda.test.ts tests/disjuntor.test.ts --maxWorkers=1 --minWorkers=1`
Esperado: PASS (o `disjuntor.test.ts` existente continua verde).

- [ ] **Passo 6: commit**

```bash
git add src/integrations/brindeme/circuitBreaker.ts src/integrations/brindeme/precoVenda.ts tests/precoVenda.test.ts
git commit -m "feat(preco): consulta o preço de venda na rota da vitrine (app3)"
```

---

### Tarefa 2: faixas de venda (funções puras)

**Arquivos:**
- Criar: `src/catalogo/faixasDeVenda.ts`
- Teste: `tests/faixasDeVenda.test.ts`

**Interfaces:**
- Produz: `interface Limite { min: number; max: number }`, `DEGRAUS_DO_SITE`, `pontosDeConsulta(limites: Limite[], minimo: number): number[]`, `montarFaixasDeVenda(limites: Limite[], minimo: number, precos: Map<number, number>): PriceRange[]`, `proximoDegrau(faixas: PriceRange[], quantidade: number): number | undefined`, `chaveDoGrupo(custo: PriceRange[]): string`, `hashDoGrupo(chave: string): string`, `limitesDe(faixas: PriceRange[]): Limite[]` e `centavosNaTabela(faixas: PriceRange[], quantidade: number): number`.

- [ ] **Passo 1: escrever o teste que falha** — `tests/faixasDeVenda.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  centavosNaTabela,
  chaveDoGrupo,
  hashDoGrupo,
  montarFaixasDeVenda,
  pontosDeConsulta,
  proximoDegrau,
} from "../src/catalogo/faixasDeVenda.js";

// Camisa Dray Fit (PE001), números reais de 04–05/11: custo 10–18, 19–19 e 51–100; site 42,41 / 40,51 / 38,61 / 37,84.
const LIMITES_DRAY = [{ min: 10, max: 18 }, { min: 19, max: 19 }, { min: 51, max: 100 }];
const SITE_DRAY = new Map([[10, 4241], [19, 4051], [20, 0], [51, 3861], [100, 3784], [101, 0], [500, 0], [1000, 0], [5000, 0]]);

describe("faixas de venda", () => {
  it("pontos: mínimo, limites (min e max+1) e os degraus 100/500/1000/5000, a partir do mínimo", () => {
    expect(pontosDeConsulta(LIMITES_DRAY, 10)).toEqual([10, 19, 20, 51, 100, 101, 500, 1000, 5000]);
    expect(pontosDeConsulta([{ min: 1, max: 9_999_999 }], 50)).toEqual([50, 100, 500, 1000, 5000]);
  });

  it("Dray Fit: 10–18 a 42,41; 19 a 40,51; 20–50 sem faixa; 51–99 a 38,61; 100 a 37,84; 101+ sem faixa", () => {
    expect(montarFaixasDeVenda(LIMITES_DRAY, 10, SITE_DRAY)).toEqual([
      { min: 10, max: 18, price: 42.41 },
      { min: 19, max: 19, price: 40.51 },
      { min: 51, max: 99, price: 38.61 },
      { min: 100, max: 100, price: 37.84 },
    ]);
  });

  it("caneta de faixa única: degraus do site em 100, 500, 1000 e 5000; o último vai até o max da faixa de custo", () => {
    const site = new Map([[50, 792], [100, 776], [500, 768], [1000, 760], [5000, 752]]);
    expect(montarFaixasDeVenda([{ min: 1, max: 9_999_999 }], 50, site)).toEqual([
      { min: 50, max: 99, price: 7.92 },
      { min: 100, max: 499, price: 7.76 },
      { min: 500, max: 999, price: 7.68 },
      { min: 1000, max: 4999, price: 7.6 },
      { min: 5000, max: 9_999_999, price: 7.52 },
    ]);
  });

  it("faixas vizinhas com o mesmo preço se fundem e faixa com 0 não entra", () => {
    const site = new Map([[10, 500], [50, 500], [100, 0], [500, 0], [1000, 0], [5000, 0]]);
    expect(montarFaixasDeVenda([{ min: 10, max: 49 }, { min: 50, max: 99 }], 10, site)).toEqual([{ min: 10, max: 99, price: 5 }]);
  });

  it("próximo degrau: o menor início acima da quantidade com preço menor; sem faixa ou no fim, nenhum", () => {
    const faixas = montarFaixasDeVenda(LIMITES_DRAY, 10, SITE_DRAY);
    expect(proximoDegrau(faixas, 10)).toBe(19);
    expect(proximoDegrau(faixas, 19)).toBe(51);
    expect(proximoDegrau(faixas, 51)).toBe(100);
    expect(proximoDegrau(faixas, 100)).toBeUndefined();
    expect(proximoDegrau(faixas, 25)).toBeUndefined();
  });

  it("chave do grupo: mesmos limites e valor dão a mesma chave; valor diferente, outra; o hash tem 12 hex", () => {
    const azul = [{ min: 1, max: 9_999_999, price: 2.3 }];
    const roxa = [{ min: 1, max: 9_999_999, price: 2.21 }];
    expect(chaveDoGrupo(azul)).toBe(chaveDoGrupo([{ min: 1, max: 9_999_999, price: 2.3 }]));
    expect(chaveDoGrupo(azul)).not.toBe(chaveDoGrupo(roxa));
    expect(hashDoGrupo(chaveDoGrupo(azul))).toMatch(/^[0-9a-f]{12}$/);
  });

  it("centavos na tabela: preço da faixa em centavos; fora de toda faixa, 0", () => {
    const tabela = [{ min: 25, max: 99, price: 18.9 }];
    expect(centavosNaTabela(tabela, 50)).toBe(1890);
    expect(centavosNaTabela(tabela, 100)).toBe(0);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

Rode: `npx vitest run tests/faixasDeVenda.test.ts --maxWorkers=1 --minWorkers=1`
Esperado: FAIL, módulo não encontrado.

- [ ] **Passo 3: implementar** — `src/catalogo/faixasDeVenda.ts`

```ts
/**
 * Faixas de venda a partir dos limites das faixas de custo (spec da Fase 0, 5.2). O valor do custo não entra
 * em conta nenhuma: só os limites dizem onde o preço do site pode mudar.
 */
import { createHash } from "crypto";
import type { PriceRange } from "../integrations/brindeme/types.js";
import { arredondar } from "../integrations/brindeme/mappers.js";

export interface Limite {
  min: number;
  max: number;
}

/** Onde o site muda o preço além dos limites de custo (sonda de 05/11, varredura densa de 8 produtos). */
export const DEGRAUS_DO_SITE = [100, 500, 1000, 5000];
/** Faixa de custo com max acima disto não tem teto: não há "max + 1" para consultar. */
const SEM_TETO = 1_000_000;

export function pontosDeConsulta(limites: Limite[], minimo: number): number[] {
  const pontos = new Set<number>([minimo, ...DEGRAUS_DO_SITE]);
  for (const f of limites) {
    pontos.add(f.min);
    if (f.max < SEM_TETO) pontos.add(f.max + 1);
  }
  return [...pontos].filter((q) => q >= minimo).sort((a, b) => a - b);
}

export function montarFaixasDeVenda(limites: Limite[], minimo: number, precos: Map<number, number>): PriceRange[] {
  const pontos = pontosDeConsulta(limites, minimo);
  const faixas: PriceRange[] = [];
  for (let i = 0; i < pontos.length; i++) {
    const inicio = pontos[i];
    const centavos = precos.get(inicio) ?? 0;
    if (centavos <= 0) continue;
    const fim =
      i + 1 < pontos.length ? pontos[i + 1] - 1 : limites.find((f) => inicio >= f.min && inicio <= f.max)?.max;
    if (fim === undefined) continue;
    const price = arredondar(centavos / 100);
    const anterior = faixas.at(-1);
    if (anterior && anterior.max + 1 === inicio && anterior.price === price) anterior.max = fim;
    else faixas.push({ min: inicio, max: fim, price });
  }
  return faixas;
}

/** Só uma candidata: o preço que vai ao cliente sai da consulta exata dessa quantidade. */
export function proximoDegrau(faixas: PriceRange[], quantidade: number): number | undefined {
  const atual = faixas.find((f) => quantidade >= f.min && quantidade <= f.max);
  if (!atual) return undefined;
  const mais = faixas.filter((f) => f.min > quantidade && f.price < atual.price).map((f) => f.min);
  return mais.length ? Math.min(...mais) : undefined;
}

/** Cores com as mesmas faixas de custo (limites e valor) têm o mesmo preço de venda: 45 de 45 grupos na sonda. Só em memória. */
export function chaveDoGrupo(custo: PriceRange[]): string {
  return custo.map((f) => `${f.min}-${f.max}:${Math.round(f.price * 100)}`).sort().join("|");
}

export function hashDoGrupo(chave: string): string {
  return createHash("sha256").update(chave).digest("hex").slice(0, 12);
}

export const limitesDe = (faixas: PriceRange[]): Limite[] => faixas.map(({ min, max }) => ({ min, max }));

/** Nos mocks a tabela vale como preço de venda; fora de toda faixa, 0 ("a consultar"). */
export function centavosNaTabela(faixas: PriceRange[], quantidade: number): number {
  const f = faixas.find((x) => quantidade >= x.min && quantidade <= x.max);
  return f ? Math.round(f.price * 100) : 0;
}
```

- [ ] **Passo 4: rodar e ver passar**

Rode: `npx vitest run tests/faixasDeVenda.test.ts --maxWorkers=1 --minWorkers=1` → PASS.

- [ ] **Passo 5: commit**

```bash
git add src/catalogo/faixasDeVenda.ts tests/faixasDeVenda.test.ts
git commit -m "feat(preco): monta faixas de venda a partir dos limites de custo"
```

---

### Tarefa 3: `precoVenda` no cliente, fim de `Product.price` e mocks

**Arquivos:**
- Modificar: `src/integrations/brindeme/types.ts`, `client.ts`, `mappers.ts`, `mockClient.ts` e `httpClient.ts`; `src/tools/prepararOrcamento.ts:128-142`; `tests/helpers/produtos.ts`; `tests/contrato.test.ts`; `tests/mappers.test.ts`
- Teste: `tests/mockClient.test.ts` (acrescentar)

**Interfaces:**
- Consome: `ErroPrecoVenda` e `PrecoVendaHttp` (Tarefa 1); `centavosNaTabela` (Tarefa 2).
- Produz: `BrindeMeClient.precoVenda(subprodutoId: string, quantidades: number[]): Promise<Map<number, number>>`; `Subproduct.limites?`, `Subproduct.grupo_preco?` e `Subproduct.preco_indisponivel?`; `MockBrindeMeClient.falharPrecoVenda: boolean`; `ClienteCatalogoFalso.precoVendaFixo: Map<string, number>`, `.falhaNoPreco: Map<string, unknown>` e `.consultasDePreco`.

- [ ] **Passo 1: escrever o teste que falha** — acrescente ao fim de `tests/mockClient.test.ts`:

```ts
describe("preço de venda no mock", () => {
  it("a tabela do fixture vale como preço de venda, em centavos; fora da faixa, 0", async () => {
    const c = new MockBrindeMeClient();
    const r = await c.precoVenda("sub-001-branco", [50, 100, 10_000]);
    expect([...r]).toEqual([[50, 1890], [100, 1540], [10_000, 0]]);
  });

  it("falharPrecoVenda simula a rota fora; subproduto inexistente é formato", async () => {
    const c = new MockBrindeMeClient();
    await expect(c.precoVenda("nao-existe", [10])).rejects.toMatchObject({ motivo: "formato" });
    c.falharPrecoVenda = true;
    await expect(c.precoVenda("sub-001-branco", [50])).rejects.toMatchObject({ motivo: "indisponivel" });
  });
});
```

Se `describe` não estiver importado no arquivo, acrescente-o ao import do `vitest`.

- [ ] **Passo 2: rodar e ver falhar**

Rode: `npx vitest run tests/mockClient.test.ts --maxWorkers=1 --minWorkers=1` → FAIL (`precoVenda is not a function`).

- [ ] **Passo 3: tipos** — em `src/integrations/brindeme/types.ts`, troque a interface `Subproduct` por:

```ts
export interface Subproduct {
  id: string;
  sku: string;
  status: boolean;
  color: string;
  stock: number;
  /** Preço de VENDA (o do site) depois de ClienteComPrecoDeVenda; no mock, a tabela do fixture vale como venda. */
  prices: PriceRange[];
  /** Limites das faixas de custo, sem o valor: o mapa de onde o preço de venda pode mudar. */
  limites?: Array<{ min: number; max: number }>;
  /** Grupo de cores com as mesmas faixas de custo, logo com o mesmo preço de venda (hash, sem o valor). */
  grupo_preco?: string;
  /** A consulta do preço de venda do grupo falhou: prices vem vazio. */
  preco_indisponivel?: boolean;
}
```

Em `Product`, apague a linha `  price: number;` (linha 44).

- [ ] **Passo 4: interface do cliente** — em `src/integrations/brindeme/client.ts`, dentro de `BrindeMeClient`, logo depois de `getProduct(id: string): Promise<Product>;`:

```ts
  /**
   * Preço de venda do site de um subproduto, em centavos por unidade, por quantidade. 0 = "a consultar".
   * Lança ErroPrecoVenda quando não dá para saber.
   */
  precoVenda(subprodutoId: string, quantidades: number[]): Promise<Map<number, number>>;
```

- [ ] **Passo 5: mapper** — em `src/integrations/brindeme/mappers.ts`, dentro de `mapProduct`, apague a linha `    price: money(raw.price),`.

- [ ] **Passo 6: mock** — em `src/integrations/brindeme/mockClient.ts`:
  - Acrescente aos imports:
    ```ts
    import { ErroPrecoVenda } from "./precoVenda.js";
    import { centavosNaTabela } from "../../catalogo/faixasDeVenda.js";
    ```
  - Na classe, abaixo de `orcamentosCriados = 0;`:
    ```ts
      /** Simula a rota de preço da vitrine fora do ar (evals de preço indisponível). */
      falharPrecoVenda = false;

      async precoVenda(subprodutoId: string, quantidades: number[]): Promise<Map<number, number>> {
        if (this.falharPrecoVenda) throw new ErroPrecoVenda("indisponivel", "vitrine fora (simulado)");
        const sub = loadJson<Product[]>("products.json").flatMap((p) => p.subproducts).find((s) => s.id === subprodutoId);
        if (!sub) throw new ErroPrecoVenda("formato", "subproduto inexistente", { status: 404 });
        return new Map(quantidades.map((q) => [q, centavosNaTabela(sub.prices, q)]));
      }
    ```
  - Em `createBudget`, troque `const unitPrice = priceRange?.price ?? found.product.price;` por `const unitPrice = priceRange?.price ?? 0;`.

- [ ] **Passo 7: cliente HTTP** — em `src/integrations/brindeme/httpClient.ts`:
  - Import: `import { PrecoVendaHttp } from "./precoVenda.js";`
  - Em `HttpClientOptions`: `  precoVenda?: PrecoVendaHttp;`
  - Campo da classe, ao lado de `readonly circuito: CircuitBreaker;`: `  private readonly vitrine: PrecoVendaHttp;`
  - No fim do construtor: `    this.vitrine = options?.precoVenda ?? new PrecoVendaHttp({ apiLogger: this.apiLogger });`
  - Método, logo depois de `getProduct`:
    ```ts
      precoVenda(subprodutoId: string, quantidades: number[]): Promise<Map<number, number>> {
        return this.vitrine.consultar(subprodutoId, quantidades);
      }
    ```

- [ ] **Passo 8: `preparar_orcamento` sem `p.price`** (provisório até a Tarefa 11) — em `src/tools/prepararOrcamento.ts`, troque `if (!range && sub.prices.length > 0) {` por `if (!range) {`, e `const price = range?.price ?? p.price;` por `const price = range.price;`. Apague o comentário das linhas 131-132 ("O preço de referência do produto só vale para cor SEM tabela…"), que deixou de ser verdade.

- [ ] **Passo 9: cliente falso dos testes** — em `tests/helpers/produtos.ts`:
  - Imports: `import { ErroPrecoVenda } from "../../src/integrations/brindeme/precoVenda.js";` e `import { centavosNaTabela } from "../../src/catalogo/faixasDeVenda.js";`
  - Em `produto()`, apague a linha `    price: subprodutos[0]?.prices[0]?.price ?? 0,`.
  - Em `ClienteCatalogoFalso`, abaixo de `latenciaMs = 0;`:
    ```ts
      /** subproduto_id → centavos que a "vitrine" devolve em qualquer quantidade (o site diverge da tabela). */
      precoVendaFixo = new Map<string, number>();
      /** subproduto_id → erro a lançar na consulta de preço de venda. */
      falhaNoPreco = new Map<string, unknown>();
      consultasDePreco: Array<{ subprodutoId: string; quantidades: number[] }> = [];

      async precoVenda(subprodutoId: string, quantidades: number[]): Promise<Map<number, number>> {
        this.consultasDePreco.push({ subprodutoId, quantidades });
        const erro = this.falhaNoPreco.get(subprodutoId);
        if (erro) throw erro;
        const sub = this.produtos.flatMap((p) => p.subproducts).find((s) => s.id === subprodutoId);
        if (!sub) throw new ErroPrecoVenda("formato", "subproduto inexistente", { status: 404 });
        const fixo = this.precoVendaFixo.get(subprodutoId);
        return new Map(quantidades.map((q) => [q, fixo ?? centavosNaTabela(sub.prices, q)]));
      }
    ```

- [ ] **Passo 10: testes que liam `Product.price`**
  - `tests/contrato.test.ts`: apague as linhas 62-63 (`expect(typeof p.price)…` e `expect(p.price).toBeLessThan(1000)…`) e renomeie o `it` da linha 59 para `"imagem e código vêm normalizados mesmo na listagem"`.
  - `tests/mappers.test.ts`: apague a linha 62 (`expect(p.price).toBeCloseTo(3.77);`).

- [ ] **Passo 11: rodar tudo**

```bash
npm run typecheck
npx vitest run --maxWorkers=1 --minWorkers=1
```
Esperado: typecheck limpo e todos os testes verdes. Se um teste quebrar porque ainda esperava `p.price` como preço de cor sem tabela, ajuste-o para esperar `erro: "sem_faixa_de_preco"`: sem tabela não há preço.

- [ ] **Passo 12: commit**

```bash
git add -A src tests
git commit -m "feat(preco): precoVenda no cliente da loja e fim do price do produto"
```

---

### Tarefa 4: embrulho que troca o custo pelo preço de venda

**Arquivos:**
- Criar: `src/integrations/brindeme/clienteComPrecoDeVenda.ts`
- Modificar: `src/integrations/brindeme/factory.ts`
- Teste: `tests/clienteComPrecoDeVenda.test.ts`

**Interfaces:**
- Consome: `chaveDoGrupo`, `hashDoGrupo`, `limitesDe`, `montarFaixasDeVenda` e `pontosDeConsulta` (Tarefa 2); `BrindeMeClient.precoVenda` (Tarefa 3).
- Produz: `type ConsultaPreco = (subprodutoId: string, quantidades: number[]) => Promise<Map<number, number>>`, `comPrecoDeVenda(p: Product, consultar: ConsultaPreco): Promise<Product>` e `class ClienteComPrecoDeVenda implements BrindeMeClient`.

- [ ] **Passo 1: escrever o teste que falha** — `tests/clienteComPrecoDeVenda.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { comPrecoDeVenda, ClienteComPrecoDeVenda } from "../src/integrations/brindeme/clienteComPrecoDeVenda.js";
import { ErroPrecoVenda } from "../src/integrations/brindeme/precoVenda.js";
import { produto, sub, ClienteCatalogoFalso } from "./helpers/produtos.js";

// Caneta balcão (sonda de 05/11): a roxa custa 221 centavos, as outras 230; no site saem por 774 e 792.
const caneta = () =>
  produto({
    id: "caneta",
    nome: "Caneta balcão",
    min: 50,
    subprodutos: [
      sub("azul", "Azul", 500, [[1, 9_999_999, 2.3]]),
      sub("preta", "Preta", 500, [[1, 9_999_999, 2.3]]),
      sub("roxa", "Roxa", 500, [[1, 9_999_999, 2.21]]),
      sub("verde", "Verde", 500, [[1, 9_999_999, 2.3]], false),
    ],
  });

function vitrine(falhar = new Set<string>()) {
  const chamadas: Array<{ id: string; qs: number[] }> = [];
  const consultar = async (id: string, qs: number[]) => {
    chamadas.push({ id, qs });
    if (falhar.has(id)) throw new ErroPrecoVenda("rede", "fora");
    return new Map(qs.map((q) => [q, id === "roxa" ? 774 : 792]));
  };
  return { chamadas, consultar };
}

describe("custo → preço de venda", () => {
  it("uma consulta por grupo de cores; a roxa (custo diferente) fica num grupo só dela", async () => {
    const { chamadas, consultar } = vitrine();
    const p = await comPrecoDeVenda(caneta(), consultar);
    expect(chamadas.map((c) => c.id).sort()).toEqual(["azul", "roxa"]);
    expect(chamadas[0].qs).toEqual([50, 100, 500, 1000, 5000]);
    const porCor = Object.fromEntries(p.subproducts.map((s) => [s.color, s.prices]));
    expect(porCor.Azul).toEqual([{ min: 50, max: 9_999_999, price: 7.92 }]);
    expect(porCor.Preta).toEqual(porCor.Azul);
    expect(porCor.Roxa).toEqual([{ min: 50, max: 9_999_999, price: 7.74 }]);
    const [azul, preta, roxa] = p.subproducts;
    expect(azul.grupo_preco).toMatch(/^[0-9a-f]{12}$/);
    expect(preta.grupo_preco).toBe(azul.grupo_preco);
    expect(roxa.grupo_preco).not.toBe(azul.grupo_preco);
    expect(azul.limites).toEqual([{ min: 1, max: 9_999_999 }]);
  });

  it("o custo é descartado: nenhum valor de custo sobra no produto devolvido", async () => {
    const p = await comPrecoDeVenda(caneta(), vitrine().consultar);
    const precos = p.subproducts.flatMap((s) => s.prices.map((f) => f.price));
    expect(precos).not.toContain(2.3);
    expect(precos).not.toContain(2.21);
    expect(JSON.stringify(p)).not.toMatch(/"price":2\.(3|21)\b/);
  });

  it("cor inativa sai sem preço e sem grupo, e não é consultada", async () => {
    const { chamadas, consultar } = vitrine();
    const p = await comPrecoDeVenda(caneta(), consultar);
    const verde = p.subproducts.find((s) => s.color === "Verde")!;
    expect(verde.prices).toEqual([]);
    expect(verde.grupo_preco).toBeUndefined();
    expect(chamadas.some((c) => c.id === "verde")).toBe(false);
  });

  it("falha no grupo: prices vazio e preco_indisponivel nas cores dele; o outro grupo segue", async () => {
    const p = await comPrecoDeVenda(caneta(), vitrine(new Set(["roxa"])).consultar);
    const roxa = p.subproducts.find((s) => s.color === "Roxa")!;
    expect(roxa).toMatchObject({ prices: [], preco_indisponivel: true });
    expect(p.subproducts.find((s) => s.color === "Azul")!.preco_indisponivel).toBeUndefined();
  });

  it("cor sem faixa de custo não consulta o site e fica sem preço (o 0 cai onde não há faixa)", async () => {
    const { chamadas, consultar } = vitrine();
    const p = await comPrecoDeVenda(produto({ id: "x", nome: "X", subprodutos: [sub("s", "Única", 10, [])] }), consultar);
    expect(chamadas).toEqual([]);
    expect(p.subproducts[0]).toMatchObject({ prices: [], limites: [] });
    expect(p.subproducts[0].preco_indisponivel).toBeUndefined();
  });

  it("o cliente embrulhado aplica isso no getProduct e repassa o resto", async () => {
    const dentro = new ClienteCatalogoFalso([caneta()]);
    dentro.precoVendaFixo.set("azul", 792);
    dentro.precoVendaFixo.set("roxa", 774);
    const c = new ClienteComPrecoDeVenda(dentro);
    const p = await c.getProduct("caneta");
    expect(p.subproducts.find((s) => s.color === "Roxa")!.prices[0].price).toBe(7.74);
    expect((await c.listProducts()).data).toHaveLength(1);
    expect((await c.precoVenda("azul", [10])).get(10)).toBe(792);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar** → FAIL, módulo não encontrado.

- [ ] **Passo 3: implementar** — `src/integrations/brindeme/clienteComPrecoDeVenda.ts`

```ts
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
import { chaveDoGrupo, hashDoGrupo, limitesDe, montarFaixasDeVenda, pontosDeConsulta } from "../../catalogo/faixasDeVenda.js";

export type ConsultaPreco = (subprodutoId: string, quantidades: number[]) => Promise<Map<number, number>>;

export async function comPrecoDeVenda(p: Product, consultar: ConsultaPreco): Promise<Product> {
  const minimo = Math.max(1, p.min_quantity);
  const grupos = new Map<string, Subproduct[]>();
  for (const s of p.subproducts) {
    if (!s.status) continue;
    const chave = chaveDoGrupo(s.prices);
    grupos.set(chave, [...(grupos.get(chave) ?? []), s]);
  }

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
      } catch {
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
        grupo_preco: hashDoGrupo(chave),
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
```

- [ ] **Passo 4: fábrica** — `src/integrations/brindeme/factory.ts`:

```ts
import type { BrindeMeClient } from "./client.js";
import { MockBrindeMeClient } from "./mockClient.js";
import { HttpBrindeMeClient } from "./httpClient.js";
import { ClienteComPrecoDeVenda } from "./clienteComPrecoDeVenda.js";
import { config } from "../../config.js";

/** Escolhe a implementação pelo BRINDEME_MODE. As tools não sabem qual é. */
export function createBrindeMeClient(opcoes: { reqPorMinuto?: number } = {}): BrindeMeClient {
  if (config.brindeMe.mode !== "http") return new MockBrindeMeClient();
  return new ClienteComPrecoDeVenda(new HttpBrindeMeClient({ reqPorMinuto: opcoes.reqPorMinuto }));
}
```

- [ ] **Passo 5: rodar** — `npx vitest run tests/clienteComPrecoDeVenda.test.ts --maxWorkers=1 --minWorkers=1` → PASS. Depois `npm run typecheck` → limpo.

- [ ] **Passo 6: commit**

```bash
git add src/integrations/brindeme/clienteComPrecoDeVenda.ts src/integrations/brindeme/factory.ts tests/clienteComPrecoDeVenda.test.ts
git commit -m "feat(preco): produto da API sai com o preço de venda e sem custo"
```

---

### Tarefa 5: índice v2

**Arquivos:**
- Modificar: `src/catalogo/indice.ts`
- Teste: `tests/catalogoSync.test.ts` (acrescentar)

**Interfaces:**
- Produz: `VERSAO_INDICE = 2`; `SubprodutoIndexado` com `limites?`, `grupo_preco?` e `faixas_venda_em?` (opcionais, para os testes que montam registro à mão continuarem compilando; `construirRegistro` sempre preenche).

- [ ] **Passo 1: escrever o teste que falha** — acrescente a `tests/catalogoSync.test.ts` (use os imports que o arquivo já tem; acrescente `FileProductIndexStore`, `VERSAO_INDICE`, `construirRegistro` e os helpers de `./helpers/produtos.js` se faltarem, além de `mkdtempSync`, `writeFileSync`, `tmpdir` e `join`):

```ts
describe("índice v2 (preço de venda)", () => {
  it("o registro guarda limites, grupo e a data das faixas de venda", () => {
    const p = produto({ id: "p", nome: "P", subprodutos: [{ ...sub("s", "Azul", 10, [[10, 99, 5]]), limites: [{ min: 10, max: 99 }], grupo_preco: "abc123abc123" }] });
    const r = construirRegistro(p, new Date("2026-11-06T03:00:00Z"));
    expect(r.subprodutos[0]).toMatchObject({
      faixas: [{ min: 10, max: 99, preco: 5 }],
      limites: [{ min: 10, max: 99 }],
      grupo_preco: "abc123abc123",
      faixas_venda_em: "2026-11-06T03:00:00.000Z",
    });
  });

  it("produto com preço de venda indisponível conta como falha e mantém o registro anterior", async () => {
    const p = produto({ id: "p", nome: "P" });
    const store = new MemoryProductIndexStore();
    const cliente = new ClienteCatalogoFalso([p]);
    await sincronizarCatalogo(cliente, store);
    const anterior = store.carregar().produtos[0];
    cliente.alterar("p", (x) => {
      x.subproducts[0].preco_indisponivel = true;
      x.subproducts[0].prices = [];
    });
    const r = await sincronizarCatalogo(cliente, store, { forcar: true });
    expect(r.falhas).toEqual([{ id: "p", erro: "preco_de_venda_indisponivel" }]);
    expect(store.carregar().produtos[0].subprodutos[0].faixas).toEqual(anterior.subprodutos[0].faixas);
  });

  it("um índice v1 no disco carrega vazio (Foco da revisão 3: é preciso migrar)", () => {
    const dir = mkdtempSync(join(tmpdir(), "indice-v1-"));
    const arquivo = join(dir, "produtos-index.json");
    writeFileSync(arquivo, JSON.stringify({ versao: 1, sincronizado_em: "x", completo: true, produtos: [{ id: "a" }] }));
    expect(VERSAO_INDICE).toBe(2);
    expect(new FileProductIndexStore(arquivo).carregar().produtos).toEqual([]);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar** → FAIL (campos ausentes e versão 1).

- [ ] **Passo 3: implementar** em `src/catalogo/indice.ts`:
  - Linha 34: `export const VERSAO_INDICE = 2;`
  - Em `FaixaPreco`, troque o comentário `/** Reais. */` por `/** Reais: preço de venda (o do site). */`.
  - `SubprodutoIndexado`:
    ```ts
    export interface SubprodutoIndexado {
      id: string;
      sku: string;
      cor: string;
      estoque: number;
      faixas: FaixaPreco[];
      /** Limites das faixas de custo, sem o valor: o sync:precos reconsulta o site nestes pontos. */
      limites?: Array<{ min: number; max: number }>;
      /** Cores com o mesmo grupo têm o mesmo preço de venda (ver faixasDeVenda.chaveDoGrupo). */
      grupo_preco?: string;
      /** Quando as faixas de venda foram lidas do site (ISO). */
      faixas_venda_em?: string;
    }
    ```
  - Em `construirRegistro`, troque o `.map((s) => ({ ... }))` dos subprodutos por:
    ```ts
          .map((s) => ({
            id: s.id,
            sku: s.sku,
            cor: s.color,
            estoque: Math.max(0, s.stock),
            faixas: s.prices.map((f) => ({ min: f.min, max: f.max, preco: arredondar(f.price) })),
            limites: s.limites ?? s.prices.map(({ min, max }) => ({ min, max })),
            grupo_preco: s.grupo_preco ?? "",
            faixas_venda_em: agora.toISOString(),
          })),
    ```
  - Em `sincronizarCatalogo`, dentro do `try` de `trabalhador`, logo depois de `const detalhe = await client.getProduct(p.id);`:
    ```ts
            // Sem o preço de venda, o registro anterior vale mais que um produto sem preço.
            if (detalhe.subproducts.some((s) => s.status && s.preco_indisponivel)) throw new Error("preco_de_venda_indisponivel");
    ```

- [ ] **Passo 4: rodar tudo** — `npm run typecheck` e `npx vitest run --maxWorkers=1 --minWorkers=1`. Esperado: verde. O `tests/contrato.test.ts` "o registro do índice guarda só o necessário" confere as chaves do **produto**, não do subproduto, e não deve quebrar.

- [ ] **Passo 5: commit**

```bash
git add src/catalogo/indice.ts tests/catalogoSync.test.ts
git commit -m "feat(preco): índice v2 com preço de venda, limites e grupo de cor"
```

---

### Tarefa 6: produtos sob demanda

**Arquivos:**
- Criar: `src/knowledge/sob-demanda.json` e `src/catalogo/sobDemanda.ts`
- Modificar: `src/catalogo/oferta.ts`, `src/catalogo/verificacao.ts` e `src/partida.ts`
- Teste: `tests/sobDemanda.test.ts`

**Interfaces:**
- Produz: `ehSobDemanda(produtoId: string): boolean`, `setSobDemanda(ids: string[] | null): void` e `sobDemandaAusentes(idsNoIndice: Set<string>): Array<{ id: string; nome: string }>`.
- `calcularOferta(produto: Pick<ProdutoIndexado, "quantidade_minima" | "subprodutos"> & { id?: string }, ...)`.

- [ ] **Passo 1: a lista** — `src/knowledge/sob-demanda.json`:

```json
{ "produtos": [
  { "id": "afc89ae2-d187-405a-b826-d2e2ae0447f5", "nome": "Camisa Dray Fit" },
  { "id": "dd4c5dbf-ab7d-4084-8c2b-e2f7e28669de", "nome": "Caneca Mágica" }
] }
```

- [ ] **Passo 2: escrever o teste que falha** — `tests/sobDemanda.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { ehSobDemanda, setSobDemanda, sobDemandaAusentes } from "../src/catalogo/sobDemanda.js";
import { calcularOferta } from "../src/catalogo/oferta.js";
import { verificarSugestao } from "../src/catalogo/verificacao.js";
import { produto, sub } from "./helpers/produtos.js";

const indexado = (id: string, estoque: number) => ({
  id,
  quantidade_minima: 10,
  subprodutos: [{ id: `${id}-s`, sku: "x", cor: "Branca", estoque, faixas: [{ min: 10, max: 9999, preco: 42.41 }] }],
});

describe("sob demanda", () => {
  afterEach(() => setSobDemanda(null));

  it("a lista do repo traz só a Camisa Dray Fit e a Caneca Mágica", () => {
    expect(ehSobDemanda("afc89ae2-d187-405a-b826-d2e2ae0447f5")).toBe(true);
    expect(ehSobDemanda("dd4c5dbf-ab7d-4084-8c2b-e2f7e28669de")).toBe(true);
    expect(ehSobDemanda("prod-001")).toBe(false);
  });

  it("sob demanda passa com estoque 0 e qualquer quantidade a partir do mínimo; os outros não", () => {
    setSobDemanda(["dray"]);
    expect(calcularOferta(indexado("dray", 0), 5000)).toMatchObject({ ok: true });
    expect(calcularOferta(indexado("dray", 0), 5)).toMatchObject({ ok: false, motivo: "abaixo_do_minimo" });
    expect(calcularOferta(indexado("outro", 0), 50)).toMatchObject({ ok: false, motivo: "sem_estoque" });
    expect(calcularOferta(indexado("outro", 20), 50)).toMatchObject({ ok: false, motivo: "estoque_insuficiente" });
  });

  it("verificacao.ts concorda com oferta.ts sobre o estoque", () => {
    setSobDemanda(["dray"]);
    const sugestao = { quantidade: 100, preco_unitario: 42.41, total_estimado: 4241, cores: [{ subproduto_id: "dray-s", preco_unitario: 42.41 }] };
    const dray = produto({ id: "dray", nome: "Camisa Dray Fit", min: 10, subprodutos: [sub("dray-s", "Branca", 0, [[10, 9999, 42.41]])] });
    expect(verificarSugestao(dray, sugestao, { quantidade: 100 }).filter((v) => v.regra === "estoque")).toEqual([]);
    const outro = produto({ id: "outro", nome: "Outro", min: 10, subprodutos: [sub("dray-s", "Branca", 0, [[10, 9999, 42.41]])] });
    expect(verificarSugestao(outro, sugestao, { quantidade: 100 }).some((v) => v.regra === "estoque")).toBe(true);
  });

  it("aponta ids da lista que não estão no índice", () => {
    expect(sobDemandaAusentes(new Set(["afc89ae2-d187-405a-b826-d2e2ae0447f5"]))).toEqual([
      { id: "dd4c5dbf-ab7d-4084-8c2b-e2f7e28669de", nome: "Caneca Mágica" },
    ]);
  });
});
```

- [ ] **Passo 3: rodar e ver falhar** → FAIL, módulo não encontrado.

- [ ] **Passo 4: implementar** — `src/catalogo/sobDemanda.ts`

```ts
/**
 * Produtos próprios da loja, feitos sob demanda: o estoque da API não vale e qualquer quantidade a partir do
 * mínimo é aceita. A lista é local (src/knowledge/sob-demanda.json); nada é cadastrado na brinde.me.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

interface ListaSobDemanda {
  produtos: Array<{ id: string; nome: string }>;
}

function lerLista(): ListaSobDemanda {
  return JSON.parse(readFileSync(join(__dir, "../knowledge/sob-demanda.json"), "utf-8")) as ListaSobDemanda;
}

let ids: Set<string> | null = null;

export function ehSobDemanda(produtoId: string): boolean {
  ids ??= new Set(lerLista().produtos.map((p) => p.id));
  return ids.has(produtoId);
}

/** Para testes e evals; null volta à lista do arquivo. */
export function setSobDemanda(lista: string[] | null): void {
  ids = lista ? new Set(lista) : null;
}

/** Ids da lista que não estão no índice: aviso na partida, sem derrubar o agente. */
export function sobDemandaAusentes(idsNoIndice: Set<string>): Array<{ id: string; nome: string }> {
  return lerLista().produtos.filter((p) => !idsNoIndice.has(p.id));
}
```

- [ ] **Passo 5: `oferta.ts`**
  - Import: `import { ehSobDemanda } from "./sobDemanda.js";`
  - Assinatura: `produto: Pick<ProdutoIndexado, "quantidade_minima" | "subprodutos"> & { id?: string },`
  - Troque `const comEstoque = produto.subprodutos.filter((s) => s.estoque > 0);` por:
    ```ts
      const sobDemanda = produto.id !== undefined && ehSobDemanda(produto.id);
      const comEstoque = sobDemanda ? produto.subprodutos : produto.subprodutos.filter((s) => s.estoque > 0);
    ```
  - Troque `const cobrem = comEstoque.filter((s) => s.estoque >= quantidade);` por `const cobrem = sobDemanda ? comEstoque : comEstoque.filter((s) => s.estoque >= quantidade);`.
  - No comentário de decisões do topo, acrescente: ` *  - SOB DEMANDA (src/knowledge/sob-demanda.json): estoque ignorado.`

- [ ] **Passo 6: `verificacao.ts`** — import `import { ehSobDemanda } from "./sobDemanda.js";` e troque `if (sub.stock < s.quantidade) {` por `if (!ehSobDemanda(produto.id) && sub.stock < s.quantidade) {`.

- [ ] **Passo 7: aviso na partida** — em `src/partida.ts`, acrescente o import `import { sobDemandaAusentes } from "./catalogo/sobDemanda.js";` e, dentro do `try` de `avisarConhecimentoECatalogo`, depois do último `else { console.log(... Índice de catálogo ...) }`:

```ts
    if (config.brindeMe.mode === "http") {
      const noIndice = new Set(new FileProductIndexStore().carregar().produtos.map((p) => p.id));
      for (const p of sobDemandaAusentes(noIndice)) {
        console.log(`${YELLOW}! sob demanda: "${p.nome}" (${p.id}) não está no índice do catálogo${RESET}`);
      }
    }
```

- [ ] **Passo 8: rodar** — `npx vitest run tests/sobDemanda.test.ts tests/oferta.test.ts --maxWorkers=1 --minWorkers=1` → PASS; `npm run typecheck` → limpo.

- [ ] **Passo 9: commit**

```bash
git add src/knowledge/sob-demanda.json src/catalogo/sobDemanda.ts src/catalogo/oferta.ts src/catalogo/verificacao.ts src/partida.ts tests/sobDemanda.test.ts
git commit -m "feat(estoque): Camisa Dray Fit e Caneca Mágica sob demanda"
```

---

### Tarefa 7: cotação exata ao vivo

**Arquivos:**
- Criar: `src/catalogo/cotacao.ts`
- Modificar: `src/agent/state.ts`
- Teste: `tests/cotacao.test.ts`

**Interfaces:**
- Consome: `BrindeMeClient.precoVenda`, `ErroPrecoVenda` e `MotivoErroPreco`.
- Produz: `MAX_CORES_COTADAS = 6`, `VALIDADE_COTACAO_MS`, `interface Cotacao`, `interface FalhaCotacao`, `type ResultadoCotacao`, `cotou(r): r is Cotacao`, `interface ItemCotacao`, `cotarAoVivo(client, itens, agora?): Promise<ResultadoCotacao[]>`, `guardarCotacoes(state, resultados, agora?)` e `cotacaoValida(state, subprodutoId, quantidade, agora?): Cotacao | undefined`; `ConversationState.cotacoes?: Record<string, Cotacao>`.

- [ ] **Passo 1: escrever o teste que falha** — `tests/cotacao.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { cotarAoVivo, cotacaoValida, guardarCotacoes, cotou, type Cotacao } from "../src/catalogo/cotacao.js";
import { ErroPrecoVenda } from "../src/integrations/brindeme/precoVenda.js";
import { createInitialState } from "../src/agent/state.js";

const T0 = new Date("2026-11-06T12:00:00Z");

function vitrine(tabela: Record<string, Record<number, number>>, latenciaMs = 0) {
  const chamadas: Array<{ id: string; qs: number[] }> = [];
  let emVoo = 0;
  let maximo = 0;
  return {
    chamadas,
    maximo: () => maximo,
    precoVenda: async (id: string, qs: number[]) => {
      chamadas.push({ id, qs });
      emVoo++;
      maximo = Math.max(maximo, emVoo);
      try {
        if (latenciaMs) await new Promise((r) => setTimeout(r, latenciaMs));
        if (!tabela[id]) throw new ErroPrecoVenda("rede", "fora");
        return new Map(qs.map((q) => [q, tabela[id][q] ?? 0]));
      } finally {
        emVoo--;
      }
    },
  };
}

describe("cotação exata ao vivo", () => {
  it("uma chamada por cor, com o próximo degrau na mesma chamada", async () => {
    const v = vitrine({ branca: { 10: 4241, 19: 4051 }, preta: { 10: 4241, 19: 4051 } });
    const r = await cotarAoVivo(v, [
      { subprodutoId: "branca", quantidade: 10, proximoDegrau: 19 },
      { subprodutoId: "preta", quantidade: 10, proximoDegrau: 19 },
    ], () => T0);
    expect(v.chamadas).toEqual([{ id: "branca", qs: [10, 19] }, { id: "preta", qs: [10, 19] }]);
    expect(r[0]).toEqual({ subproduto_id: "branca", quantidade: 10, centavos: 4241, proximo: { quantidade: 19, centavos: 4051 }, fonte: "site", em: T0.toISOString() });
  });

  it("o degrau só entra se for mais barato e tiver preço", async () => {
    const v = vitrine({ s: { 10: 4241, 100: 4241, 500: 0 } });
    const [a] = await cotarAoVivo(v, [{ subprodutoId: "s", quantidade: 10, proximoDegrau: 100 }]);
    const [b] = await cotarAoVivo(v, [{ subprodutoId: "s", quantidade: 10, proximoDegrau: 500 }]);
    expect(cotou(a) && a.proximo).toBeFalsy();
    expect(cotou(b) && b.proximo).toBeFalsy();
  });

  it("falha vira FalhaCotacao com o motivo; 0 é cotação 'a consultar'", async () => {
    const v = vitrine({ s: { 25: 0 } });
    const [falhou, zero] = await cotarAoVivo(v, [{ subprodutoId: "fora", quantidade: 10 }, { subprodutoId: "s", quantidade: 25 }]);
    expect(falhou).toEqual({ subproduto_id: "fora", quantidade: 10, erro: "rede" });
    expect(cotou(zero) && zero.centavos).toBe(0);
  });

  it("no máximo 6 em paralelo", async () => {
    const tabela = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, { 10: 100 }]));
    const v = vitrine(tabela, 5);
    await cotarAoVivo(v, Object.keys(tabela).map((id) => ({ subprodutoId: id, quantidade: 10 })));
    expect(v.maximo()).toBe(6);
  });

  it("guardada vale 1 h, só para a mesma cor e quantidade e só com fonte site", () => {
    const state = createInitialState("5583999990000");
    const c: Cotacao = { subproduto_id: "s", quantidade: 10, centavos: 4241, fonte: "site", em: T0.toISOString() };
    guardarCotacoes(state, [c], T0);
    expect(cotacaoValida(state, "s", 10, new Date(T0.getTime() + 59 * 60_000))).toEqual(c);
    expect(cotacaoValida(state, "s", 10, new Date(T0.getTime() + 60 * 60_000))).toBeUndefined();
    expect(cotacaoValida(state, "s", 25, T0)).toBeUndefined();
    expect(cotacaoValida(state, "outra", 10, T0)).toBeUndefined();
    state.cotacoes!["s:10"] = { ...c, fonte: "indice" as "site" };
    expect(cotacaoValida(state, "s", 10, T0)).toBeUndefined();
  });

  it("guardar descarta as vencidas", () => {
    const state = createInitialState("5583999990000");
    guardarCotacoes(state, [{ subproduto_id: "velha", quantidade: 1, centavos: 1, fonte: "site", em: T0.toISOString() }], T0);
    guardarCotacoes(state, [], new Date(T0.getTime() + 2 * 3_600_000));
    expect(state.cotacoes).toEqual({});
  });
});
```

- [ ] **Passo 2: rodar e ver falhar** → FAIL, módulo não encontrado.

- [ ] **Passo 3: estado** — em `src/agent/state.ts`, acrescente no topo `import type { Cotacao } from "../catalogo/cotacao.js";` e, em `ConversationState`, logo depois de `fichaPedido?: FichaPedido;`:

```ts
  /** Preços exatos do site já consultados nesta conversa (chave `subproduto_id:quantidade`), válidos por 1 h. */
  cotacoes?: Record<string, Cotacao>;
```

- [ ] **Passo 4: implementar** — `src/catalogo/cotacao.ts`

```ts
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
```

- [ ] **Passo 5: rodar** — `npx vitest run tests/cotacao.test.ts --maxWorkers=1 --minWorkers=1` → PASS; `npm run typecheck` → limpo.

- [ ] **Passo 6: commit**

```bash
git add src/catalogo/cotacao.ts src/agent/state.ts tests/cotacao.test.ts
git commit -m "feat(preco): cotação exata ao vivo por cor, guardada por 1 h"
```

---

### Tarefa 8: legenda do cartão

**Arquivos:**
- Criar: `src/tools/cartao.ts`
- Teste: `tests/cartao.test.ts`

**Interfaces:**
- Consome: `Cotacao`, `ResultadoCotacao` e `cotou` (Tarefa 7); `reais` de `./prepararOrcamento.js`.
- Produz: `interface Cartao { produto_id: string; imagem_url: string | null; legenda: string }`, `interface DadosCartao`, `montarCartao(d: DadosCartao): Cartao`, `SEM_PRECO`, `CONDICAO_ESPECIAL` e `DEMAIS_CORES`.

- [ ] **Passo 1: escrever o teste que falha** — `tests/cartao.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { montarCartao, SEM_PRECO, CONDICAO_ESPECIAL, DEMAIS_CORES } from "../src/tools/cartao.js";
import { reais } from "../src/tools/prepararOrcamento.js";
import type { Cotacao } from "../src/catalogo/cotacao.js";

const cot = (centavos: number, proximo?: Cotacao["proximo"]): Cotacao => ({
  subproduto_id: "s",
  quantidade: 10,
  centavos,
  ...(proximo ? { proximo } : {}),
  fonte: "site",
  em: "2026-11-06T12:00:00.000Z",
});

const base = { produto_id: "dray", nome: "Camisa Dray Fit", imagem_url: "https://cdn.brinde.me/dray.webp", outras: [] as string[] };

describe("cartão do produto", () => {
  it("um preço quando todas as cores custam igual, mais o próximo degrau", () => {
    const c = montarCartao({ ...base, quantidade: 10, cotadas: [
      { cor: "Branca", cotacao: cot(4241, { quantidade: 19, centavos: 4051 }) },
      { cor: "Preta", cotacao: cot(4241, { quantidade: 19, centavos: 4051 }) },
    ] });
    expect(c).toEqual({
      produto_id: "dray",
      imagem_url: "https://cdn.brinde.me/dray.webp",
      legenda: [
        "*Camisa Dray Fit*",
        "Cores: Branca, Preta",
        `${reais(42.41)}/un para 10 un.`,
        `A partir de 19 un.: ${reais(40.51)}/un`,
      ].join("\n"),
    });
  });

  it("cor a cor quando os preços diferem, do mais barato ao mais caro", () => {
    const c = montarCartao({ ...base, quantidade: 50, cotadas: [
      { cor: "Azul", cotacao: cot(792) },
      { cor: "Roxa", cotacao: cot(774) },
      { cor: "Preta", cotacao: cot(792) },
    ] });
    expect(c.legenda).toContain(`Para 50 un.:\nRoxa: ${reais(7.74)}/un\nAzul, Preta: ${reais(7.92)}/un`);
  });

  it("sem degrau mais barato: a frase da condição especial", () => {
    expect(montarCartao({ ...base, quantidade: 100, cotadas: [{ cor: "Branca", cotacao: cot(3784) }] }).legenda).toContain(CONDICAO_ESPECIAL);
  });

  it("sem preço exato (falha ou 0): 'Valor a confirmar com a equipe.' e nenhuma condição", () => {
    const c = montarCartao({ ...base, quantidade: 25, cotadas: [
      { cor: "Branca", cotacao: { subproduto_id: "s", quantidade: 25, erro: "rede" } },
      { cor: "Preta", cotacao: cot(0) },
    ] });
    expect(c.legenda).toContain(SEM_PRECO);
    expect(c.legenda).not.toMatch(/R\$|A partir de|condição/);
  });

  it("cor com preço e cor sem preço no mesmo produto", () => {
    const c = montarCartao({ ...base, quantidade: 10, cotadas: [
      { cor: "Branca", cotacao: cot(4241) },
      { cor: "Preta", cotacao: { subproduto_id: "p", quantidade: 10, erro: "timeout" } },
    ] });
    expect(c.legenda).toContain(`${reais(42.41)}/un para 10 un.`);
    expect(c.legenda).toContain("Preta: valor a confirmar com a equipe.");
  });

  it("sem quantidade: só nome e cores, nenhum valor", () => {
    const c = montarCartao({ ...base, cotadas: [], outras: ["Branca", "Preta"] });
    expect(c.legenda).toBe("*Camisa Dray Fit*\nCores: Branca, Preta");
  });

  it("cores além das 6 conferidas aparecem pelo nome e ganham a linha 'valor confirmo quando escolher'", () => {
    const c = montarCartao({ ...base, quantidade: 10, cotadas: [{ cor: "Branca", cotacao: cot(4241) }], outras: ["Lilás"] });
    expect(c.legenda).toContain("Cores: Branca, Lilás");
    expect(c.legenda).toContain(DEMAIS_CORES);
  });

  it("nunca traz SKU nem quantidade mínima", () => {
    const c = montarCartao({ ...base, quantidade: 10, cotadas: [{ cor: "Branca", cotacao: cot(4241) }] });
    expect(c.legenda).not.toMatch(/sku|PE001|mínim|minim/i);
  });

  it("cor vazia (produto sem variação) não vira 'Cores:'", () => {
    expect(montarCartao({ ...base, quantidade: 10, cotadas: [{ cor: "", cotacao: cot(500) }] }).legenda).not.toContain("Cores:");
  });
});
```

- [ ] **Passo 2: rodar e ver falhar** → FAIL, módulo não encontrado.

- [ ] **Passo 3: implementar** — `src/tools/cartao.ts`

```ts
/**
 * Cartão de produto no formato do Dudu (ClickUp, 04/11): foto e legenda com nome, cores, preço unitário e
 * condição para mais unidades. Sem SKU e sem mínimo. O preço vem só da cotação exata do site.
 */
import { cotou, type Cotacao, type ResultadoCotacao } from "../catalogo/cotacao.js";
import { reais } from "./prepararOrcamento.js";

export interface Cartao {
  produto_id: string;
  imagem_url: string | null;
  legenda: string;
}

export interface DadosCartao {
  produto_id: string;
  nome: string;
  imagem_url: string | null;
  /** Sem quantidade, o cartão sai sem preço. */
  quantidade?: number;
  /** Cores conferidas no site (até 6), na ordem de exibição. */
  cotadas: Array<{ cor: string; cotacao: ResultadoCotacao }>;
  /** Cores disponíveis além das conferidas. */
  outras: string[];
}

export const SEM_PRECO = "Valor a confirmar com a equipe.";
export const CONDICAO_ESPECIAL = "Para quantidades maiores, a equipe faz uma condição especial.";
export const DEMAIS_CORES = "Demais cores: valor confirmo quando escolher.";

const porUnidade = (centavos: number) => `${reais(centavos / 100)}/un`;

export function montarCartao(d: DadosCartao): Cartao {
  const cores = [...d.cotadas.map((c) => c.cor), ...d.outras].filter(Boolean);
  const linhas = [`*${d.nome}*`];
  if (cores.length) linhas.push(`Cores: ${cores.join(", ")}`);
  if (d.quantidade !== undefined) {
    linhas.push(...linhasDePreco(d.cotadas, d.quantidade));
    if (d.outras.length) linhas.push(DEMAIS_CORES);
  }
  return { produto_id: d.produto_id, imagem_url: d.imagem_url, legenda: linhas.join("\n") };
}

function linhasDePreco(cotadas: DadosCartao["cotadas"], quantidade: number): string[] {
  const comPreco = cotadas.filter(
    (c): c is { cor: string; cotacao: Cotacao } => cotou(c.cotacao) && c.cotacao.centavos > 0
  );
  if (comPreco.length === 0) return [SEM_PRECO];

  const linhas: string[] = [];
  const porValor = new Map<number, string[]>();
  for (const c of comPreco) porValor.set(c.cotacao.centavos, [...(porValor.get(c.cotacao.centavos) ?? []), c.cor]);
  if (porValor.size === 1) {
    linhas.push(`${porUnidade(comPreco[0].cotacao.centavos)} para ${quantidade} un.`);
  } else {
    linhas.push(`Para ${quantidade} un.:`);
    for (const [centavos, nomes] of [...porValor].sort((a, b) => a[0] - b[0])) {
      linhas.push(`${nomes.join(", ")}: ${porUnidade(centavos)}`);
    }
  }
  const semPreco = cotadas.filter((c) => !comPreco.includes(c as { cor: string; cotacao: Cotacao })).map((c) => c.cor);
  if (semPreco.length) linhas.push(`${semPreco.join(", ")}: ${SEM_PRECO.toLowerCase()}`);
  linhas.push(condicao(comPreco));
  return linhas;
}

/** Decisão 7 da spec: só o próximo degrau mais barato; sem ele, a frase da condição especial. */
function condicao(comPreco: Array<{ cotacao: Cotacao }>): string {
  const degraus = comPreco.map((c) => c.cotacao.proximo).filter((p): p is NonNullable<Cotacao["proximo"]> => !!p);
  if (degraus.length === 0) return CONDICAO_ESPECIAL;
  const quantidade = Math.min(...degraus.map((p) => p.quantidade));
  const centavos = Math.min(...degraus.filter((p) => p.quantidade === quantidade).map((p) => p.centavos));
  return `A partir de ${quantidade} un.: ${porUnidade(centavos)}`;
}
```

- [ ] **Passo 4: rodar** — `npx vitest run tests/cartao.test.ts --maxWorkers=1 --minWorkers=1` → PASS.

- [ ] **Passo 5: commit**

```bash
git add src/tools/cartao.ts tests/cartao.test.ts
git commit -m "feat(recomendacao): cartão com foto, cores, preço e condição"
```

---

### Tarefa 9: busca com cotação exata, orçamento conferido de novo e autocorreção

**Arquivos:**
- Criar: `src/catalogo/logPrecos.ts`
- Modificar: `src/catalogo/recomendar.ts`, `src/tools/buscarProdutos.ts` e `src/tools/index.ts` (descrição de `buscar_produtos`)
- Teste: `tests/precoDeVendaNaBusca.test.ts`; ajustar `tests/contrato.test.ts` e `tests/buscarProdutosTool.test.ts`

**Interfaces:**
- Consome: `cotarAoVivo`, `cotou`, `guardarCotacoes`, `MAX_CORES_COTADAS` e `Cotacao` (Tarefa 7); `proximoDegrau` (Tarefa 2); `montarCartao` e `Cartao` (Tarefa 8); `tetoUnitarioCentavos` (`oferta.ts`, já exportado).
- Produz: `ItemRecomendado.cotacoes: ResultadoCotacao[]` (alinhado com `oferta.cores.slice(0, cotacoes.length)`); `Ajuste` com preços opcionais e exatos; `logarPrecoDivergente(e)` e `setLogPrecos(f)`; a saída de `buscar_produtos` com `cartoes: Cartao[]`, sem `sku` e sem `imagem_url` por produto.

- [ ] **Passo 1: escrever o teste que falha** — `tests/precoDeVendaNaBusca.test.ts`

```ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { recomendar } from "../src/catalogo/recomendar.js";
import { construirRegistro, MemoryProductIndexStore, VERSAO_INDICE } from "../src/catalogo/indice.js";
import { MemoryOccasionTagStore } from "../src/catalogo/ocasioes.js";
import { setLogPrecos, type PrecoDivergente } from "../src/catalogo/logPrecos.js";
import { buscarProdutosHandler, setProductIndexStore, setOccasionTagStore } from "../src/tools/buscarProdutos.js";
import { SEM_PRECO } from "../src/tools/cartao.js";
import { ErroPrecoVenda } from "../src/integrations/brindeme/precoVenda.js";
import { createInitialState } from "../src/agent/state.js";
import { ClienteCatalogoFalso, produto, sub } from "./helpers/produtos.js";
import type { Product } from "../src/integrations/brindeme/types.js";

const T0 = new Date("2026-11-06T12:00:00Z");

function montar(produtos: Product[]) {
  const index = new MemoryProductIndexStore({
    versao: VERSAO_INDICE,
    sincronizado_em: T0.toISOString(),
    completo: true,
    produtos: produtos.map((p) => construirRegistro(p, T0)),
  });
  const client = new ClienteCatalogoFalso(produtos);
  setProductIndexStore(index);
  setOccasionTagStore(new MemoryOccasionTagStore());
  return { index, client, deps: { index, tags: new MemoryOccasionTagStore(), client, agora: () => T0 } };
}

const azul = () => produto({ id: "azul", nome: "Caneca Azul", subprodutos: [sub("a1", "Azul", 1000, [[1, 9999, 10]])] });
const verde = () => produto({ id: "verde", nome: "Caneca Verde", subprodutos: [sub("v1", "Verde", 1000, [[1, 9999, 12]])] });

describe("busca com o preço exato do site", () => {
  // Toda cotação diferente do índice loga: sem isto o teste escreveria em logs/precos.jsonl.
  beforeEach(() => setLogPrecos(() => {}));
  afterEach(() => {
    setProductIndexStore(null);
    setOccasionTagStore(null);
    setLogPrecos(null);
  });

  it("o preço da saída é o da cotação, não o da tabela; cada produto vira um cartão; sem SKU", async () => {
    const { client } = montar([azul()]);
    client.precoVendaFixo.set("a1", 1111);
    const state = createInitialState("5583999990000");
    const r = (await buscarProdutosHandler({ consulta: "caneca", quantidade: 50 }, state, client)) as {
      produtos: Array<Record<string, unknown>>;
      cartoes: Array<{ produto_id: string; legenda: string; imagem_url: string | null }>;
    };
    expect(r.produtos[0]).toMatchObject({ preco_unitario_na_quantidade: 11.11, total_estimado: 555.5 });
    expect(r.produtos[0].sku).toBeUndefined();
    expect(r.cartoes).toHaveLength(1);
    expect(r.cartoes[0]).toMatchObject({ produto_id: "azul", imagem_url: "https://cdn.teste/azul.jpg" });
    expect(r.cartoes[0].legenda).toContain("*Caneca Azul*");
    expect(state.cotacoes?.["a1:50"]).toMatchObject({ centavos: 1111, fonte: "site" });
  });

  it("orçamento conferido de novo com o preço exato: o item que estoura sai e entra o próximo", async () => {
    const { client, deps } = montar([azul(), verde()]);
    client.precoVendaFixo.set("a1", 1500);
    const r = await recomendar({ consulta: "caneca", quantidade: 50, precoMaxUnitario: 13 }, deps);
    expect(r.tipo).toBe("encontrados");
    if (r.tipo !== "encontrados") return;
    expect(r.itens.map((i) => i.produto.id)).toEqual(["verde"]);
    expect(r.descartadosNaRevalidacao).toBeGreaterThanOrEqual(1);
  });

  it("Foco da revisão 4: cotação que falha com orçamento informado mantém o produto, sem preço", async () => {
    const { client } = montar([azul()]);
    client.falhaNoPreco.set("a1", new ErroPrecoVenda("rede", "fora"));
    const r = (await buscarProdutosHandler({ consulta: "caneca", quantidade: 50, preco_max_unitario: 20 }, createInitialState("5583999990000"), client)) as {
      produtos: Array<{ id: string; preco_unitario_na_quantidade: number | null }>;
      cartoes: Array<{ legenda: string }>;
    };
    expect(r.produtos.map((p) => p.id)).toEqual(["azul"]);
    expect(r.produtos[0].preco_unitario_na_quantidade).toBeNull();
    expect(r.cartoes[0].legenda).toContain(SEM_PRECO);
  });

  it("cotação diferente do índice: vale a cotação, o log registra preco_divergente e o grupo é corrigido em memória", async () => {
    const vistos: PrecoDivergente[] = [];
    setLogPrecos((e) => vistos.push(e));
    const { client, index } = montar([azul()]);
    client.precoVendaFixo.set("a1", 1100);
    await buscarProdutosHandler({ consulta: "caneca", quantidade: 50 }, createInitialState("5583999990000"), client);
    expect(vistos).toEqual([{ produto_id: "azul", grupo_preco: "", subproduto_id: "a1", quantidade: 50, indice: 1000, site: 1100 }]);
    expect(index.carregar().produtos[0].subprodutos[0].faixas).toEqual([{ min: 1, max: 9999, preco: 11 }]);
  });

  it("sem quantidade: nenhuma cotação, cartão só com nome e cores", async () => {
    const { client } = montar([azul()]);
    const r = (await buscarProdutosHandler({ consulta: "caneca" }, createInitialState("5583999990000"), client)) as { cartoes: Array<{ legenda: string }> };
    expect(client.consultasDePreco).toEqual([]);
    expect(r.cartoes[0].legenda).toBe("*Caneca Azul*\nCores: Azul");
  });

  it("todos os resultados sem estoque: diz que não tem no estoque e oferece o humano", async () => {
    const { client } = montar([produto({ id: "cam", nome: "Camiseta", subprodutos: [sub("c1", "Branca", 0, [[1, 9999, 35]])] })]);
    const r = (await buscarProdutosHandler({ consulta: "camiseta", quantidade: 30 }, createInitialState("5583999990000"), client)) as { instrucao_ao_agente: string };
    expect(r.instrucao_ao_agente).toMatch(/não tem no estoque/);
    expect(r.instrucao_ao_agente).toMatch(/humano/);
  });

  it("ajuste sugerido traz o preço exato do site", async () => {
    const { client, deps } = montar([produto({ id: "cad", nome: "Caderno", min: 50, subprodutos: [sub("d1", "Azul", 1000, [[50, 9999, 20]])] })]);
    client.precoVendaFixo.set("d1", 2100);
    const r = await recomendar({ consulta: "caderno", quantidade: 10 }, deps);
    expect(r.tipo).toBe("nenhum");
    if (r.tipo !== "nenhum") return;
    expect(r.ajustes).toEqual([{ tipo: "aumentar_quantidade", produto_id: "cad", nome: "Caderno", quantidade: 50, preco_unitario: 21, total_estimado: 1050 }]);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar** → FAIL (`logPrecos` não existe).

- [ ] **Passo 3: log de divergência** — `src/catalogo/logPrecos.ts`

```ts
/** Cotação exata diferente do índice (spec da Fase 0, 6.7): fica em logs/precos.jsonl. Valores em centavos. */
import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

export interface PrecoDivergente {
  produto_id: string;
  grupo_preco: string;
  subproduto_id: string;
  quantidade: number;
  /** null quando o índice não tinha faixa para a quantidade. */
  indice: number | null;
  site: number;
}

let destino: ((e: PrecoDivergente) => void) | null = null;

/** Para testes; null volta ao arquivo. */
export function setLogPrecos(f: ((e: PrecoDivergente) => void) | null): void {
  destino = f;
}

export function logarPrecoDivergente(e: PrecoDivergente): void {
  if (destino) return destino(e);
  try {
    const dir = join(__dir, "../../logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "precos.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), type: "preco_divergente", ...e }) + "\n", "utf-8");
  } catch {
    // não-fatal
  }
}
```

- [ ] **Passo 4: `recomendar.ts`**
  - Imports novos:
    ```ts
    import { cotarAoVivo, cotou, MAX_CORES_COTADAS, type ResultadoCotacao } from "./cotacao.js";
    import { proximoDegrau } from "./faixasDeVenda.js";
    import { logarPrecoDivergente } from "./logPrecos.js";
    import type { FaixaPreco } from "./indice.js";
    ```
    e acrescente `tetoUnitarioCentavos` ao import de `./oferta.js`.
  - Em `ItemRecomendado`, depois de `relevancia: number;`:
    ```ts
      /** Cotação exata do site das primeiras cores de `oferta.cores` (até 6), na mesma ordem. Vazio sem quantidade. */
      cotacoes: ResultadoCotacao[];
    ```
  - No tipo `Ajuste`, torne opcionais os preços: `preco_unitario?: number;`, `total_estimado?: number;` e `preco_unitario_minimo?: number;` nos três ramos.
  - No laço da revalidação, troque o bloco que começa em `const oferta = calcularOferta(registro, pedido.quantidade, orcamento);` e vai até o fim do `itens.push({...});` por:
    ```ts
          const oferta = calcularOferta(registro, pedido.quantidade, orcamento);
          if (!oferta.ok) {
            descartados++;
            continue;
          }
          let cotacoes: ResultadoCotacao[] = [];
          let cores = oferta.cores;
          if (pedido.quantidade !== undefined) {
            const q = pedido.quantidade;
            const cotadas = oferta.cores.slice(0, MAX_CORES_COTADAS);
            cotacoes = await cotarAoVivo(
              deps.client,
              cotadas.map((c) => ({
                subprodutoId: c.subproduto_id,
                quantidade: q,
                proximoDegrau: proximoDegrau(r.fresco.subproducts.find((s) => s.id === c.subproduto_id)?.prices ?? [], q),
              })),
              agora
            );
            corrigirIndice(r.c.produto, cotacoes, q);
            // O orçamento é conferido de novo com o preço exato; sem preço conhecido não dá para conferir, e o produto fica.
            const teto = tetoUnitarioCentavos(orcamento, q);
            const acima = (x: ResultadoCotacao) => cotou(x) && x.centavos > 0 && x.centavos > teto;
            const comPreco = cotacoes.filter((x) => cotou(x) && x.centavos > 0);
            if (comPreco.length > 0 && comPreco.every(acima)) {
              descartados++;
              continue;
            }
            const manter = cotacoes.map((x) => !acima(x));
            cores = [...cotadas.filter((_, i) => manter[i]), ...oferta.cores.slice(MAX_CORES_COTADAS)];
            cotacoes = cotacoes.filter((_, i) => manter[i]);
          }
          itens.push({
            produto: registro,
            oferta: { ...oferta, cores },
            ocasiaoConfere: r.c.ocasiaoConfere,
            relevancia: relevancia(r.c),
            cotacoes,
          });
    ```
  - Ajustes com preço exato. Troque `ajustes: propor(reprovados.slice(0, MAX_PARA_EXPLICAR), pedido, orcamento),` por `ajustes: await precificarAjustes(propor(reprovados.slice(0, MAX_PARA_EXPLICAR), pedido, orcamento), deps.client, agora),`.
  - Mude `propor` para devolver `Array<{ ajuste: Ajuste; subprodutoId: string }>`. Em cada `ajustes.push({ tipo: ..., ... })`, embrulhe como `ajustes.push({ ajuste: { tipo: ..., ... }, subprodutoId: o.cores[0].subproduto_id })`, onde `o` é a oferta que aprovou o ajuste naquele ramo. Troque `const jaTem = (tipo: Ajuste["tipo"]) => ajustes.some((a) => a.tipo === tipo);` por `const jaTem = (tipo: Ajuste["tipo"]) => ajustes.some((a) => a.ajuste.tipo === tipo);` e a declaração por `const ajustes: Array<{ ajuste: Ajuste; subprodutoId: string }> = [];`. Os valores de índice dentro de cada ajuste continuam (são sobrescritos abaixo).
  - Acrescente ao fim do arquivo:
    ```ts
    /** O preço do ajuste vem do site, da cor mais barata pelo índice; sem preço exato, o ajuste sai sem valor. */
    async function precificarAjustes(
      lista: Array<{ ajuste: Ajuste; subprodutoId: string }>,
      client: BrindeMeClient,
      agora: () => Date
    ): Promise<Ajuste[]> {
      if (lista.length === 0) return [];
      const cotacoes = await cotarAoVivo(client, lista.map(({ ajuste, subprodutoId }) => ({ subprodutoId, quantidade: ajuste.quantidade })), agora);
      return lista.map(({ ajuste }, i) => {
        const c = cotacoes[i];
        const exato = cotou(c) && c.centavos > 0 ? c.centavos : null;
        const preco = exato === null ? undefined : exato / 100;
        const total = exato === null ? undefined : arredondar((exato * ajuste.quantidade) / 100);
        return ajuste.tipo === "aumentar_orcamento"
          ? { ...ajuste, preco_unitario_minimo: preco, total_estimado: total }
          : { ...ajuste, preco_unitario: preco, total_estimado: total };
      });
    }

    /**
     * Autocorreção (spec 6.7): a cotação exata vale e o grupo é corrigido no índice EM MEMÓRIA. Gravar o arquivo
     * daqui disputaria com o sync:precos, que roda em outro processo.
     */
    function corrigirIndice(produto: ProdutoIndexado, cotacoes: ResultadoCotacao[], quantidade: number): void {
      for (const c of cotacoes) {
        if (!cotou(c)) continue;
        const sub = produto.subprodutos.find((s) => s.id === c.subproduto_id);
        if (!sub) continue;
        const faixa = sub.faixas.find((f) => quantidade >= f.min && quantidade <= f.max);
        const indice = faixa ? Math.round(faixa.preco * 100) : null;
        if ((indice ?? 0) === c.centavos) continue;
        logarPrecoDivergente({ produto_id: produto.id, grupo_preco: sub.grupo_preco ?? "", subproduto_id: sub.id, quantidade, indice, site: c.centavos });
        for (const s of produto.subprodutos) {
          if (s === sub || (sub.grupo_preco && s.grupo_preco === sub.grupo_preco)) s.faixas = corrigirFaixa(s.faixas, quantidade, c.centavos);
        }
      }
    }

    // shortcut: a faixa inteira fica com o preço de um ponto; o sync:precos noturno regrava o certo.
    function corrigirFaixa(faixas: FaixaPreco[], quantidade: number, centavos: number): FaixaPreco[] {
      const atual = faixas.find((f) => quantidade >= f.min && quantidade <= f.max);
      const resto = faixas.filter((f) => f !== atual);
      if (centavos === 0) return resto;
      return [...resto, { min: atual?.min ?? quantidade, max: atual?.max ?? quantidade, preco: centavos / 100 }].sort((a, b) => a.min - b.min);
    }
    ```
    Acrescente `import { arredondar } from "../integrations/brindeme/mappers.js";` aos imports.

- [ ] **Passo 5: `buscarProdutos.ts`**
  - Imports: `import { cotou, guardarCotacoes, type Cotacao } from "../catalogo/cotacao.js";`, `import { montarCartao } from "./cartao.js";` e `import { arredondar } from "../integrations/brindeme/mappers.js";`.
  - `OBSERVACAO_PRECOS`:
    ```ts
    export const OBSERVACAO_PRECOS =
      "Preço do site por quantidade. Personalização, frete e condições especiais são confirmados no orçamento.";
    ```
  - Constante nova, abaixo de `ROTULO_MOTIVO`:
    ```ts
    const INSTRUCAO_CARTOES =
      'Os cartões (foto, nome, cores, preço e condição para mais unidades) já vão ao cliente antes da sua mensagem. Não repita nome, preço, cores nem condição: apresente em uma frase e pergunte qual agrada ou qual cor. Cartão com "Valor a confirmar com a equipe": se o cliente quiser fechar esse produto, transfira com transferir_humano.';
    ```
  - No `case "nenhum"`, ramo `regras_nao_fecham`, troque a `instrucao_ao_agente` por:
    ```ts
            instrucao_ao_agente: soEstoque(r.eliminadosPor)
              ? "Diga que não tem no estoque para essa quantidade. Ofereça o ajuste de ajustes_sugeridos, se houver, e o atendimento humano para confirmar a disponibilidade (transferir_humano com motivo outro se ele aceitar). Não cite produto que não esteja em ajustes_sugeridos."
              : "Explique ao cliente, em uma frase, o que não fechou (quantidade, estoque ou valor). Se houver ajustes_sugeridos, ofereça o mais próximo e, se ele aceitar, chame buscar_produtos de novo com os novos números. Não cite produto que não esteja em ajustes_sugeridos.",
    ```
    e acrescente a função, abaixo de `explicar`:
    ```ts
    function soEstoque(eliminadosPor: Partial<Record<MotivoInelegivel, number>>): boolean {
      const motivos = Object.keys(eliminadosPor);
      return motivos.length > 0 && motivos.every((m) => m === "sem_estoque" || m === "estoque_insuficiente");
    }
    ```
  - No `case "encontrados"`, logo depois de `const informada = r.quantidadeInformada;`:
    ```ts
          guardarCotacoes(state, r.itens.flatMap((i) => i.cotacoes));
          const cartoes = r.itens.map(({ produto: p, oferta, cotacoes }) =>
            montarCartao({
              produto_id: p.id,
              nome: p.nome,
              imagem_url: p.imagem_url,
              quantidade: informada ? oferta.quantidade : undefined,
              cotadas: oferta.cores.slice(0, cotacoes.length).map((c, i) => ({ cor: c.cor, cotacao: cotacoes[i] })),
              outras: oferta.cores.slice(cotacoes.length).map((c) => c.cor),
            })
          );
    ```
  - Troque o `produtos: r.itens.map(...)` por:
    ```ts
            produtos: r.itens.map(({ produto: p, oferta, ocasiaoConfere, cotacoes }) => {
              const exatos = cotacoes.filter((c): c is Cotacao => cotou(c) && c.centavos > 0).map((c) => c.centavos);
              const menor = exatos.length ? Math.min(...exatos) : null;
              return {
                id: p.id,
                nome: p.nome,
                min_quantity: p.quantidade_minima,
                ...(informada
                  ? {
                      preco_unitario_na_quantidade: menor === null ? null : menor / 100,
                      total_estimado: menor === null ? null : arredondar((menor * oferta.quantidade) / 100),
                    }
                  : {}),
                // Produto sem variação de cor vem com color "" da API.
                cores_disponiveis: oferta.cores.map((c) => c.cor).filter(Boolean),
                // O id da cor vai junto: sem ele, o modelo mandava o id do produto ao preparar_orcamento.
                subprodutos: oferta.cores.map((c) => (c.cor ? { subproduto_id: c.subproduto_id, cor: c.cor } : { subproduto_id: c.subproduto_id })),
                ...(r.ocasioes.length ? { indicado_para_a_ocasiao: ocasiaoConfere } : {}),
              };
            }),
            cartoes,
            instrucao_ao_agente: INSTRUCAO_CARTOES,
    ```
- [ ] **Passo 6: descrição da ferramenta** — em `src/tools/index.ts`, troque a `description` de `buscar_produtos` por:

  `"Recomenda até 3 produtos da loja a partir do que o cliente procura (palavras-chave, ocasião), da quantidade e do valor (por unidade ou total). Só devolve produtos que respeitam quantidade mínima, estoque e valor, com o preço exato do site na quantidade. O sistema envia ao cliente um cartão com foto por produto (cartoes); não repita o que está neles. Use sempre que o cliente pedir recomendação ou sugestão. Nunca cite produto, preço ou estoque que não tenha vindo desta ferramenta ou de detalhar_produto."`

- [ ] **Passo 7: testes antigos que olhavam campos removidos**
  - `tests/contrato.test.ts`:
    - acrescente, depois de `fixture`, o helper:
      ```ts
      /** A rota de preço de venda da vitrine (app3): 68 centavos em toda quantidade pedida. */
      function vitrine(url: string): Response | null {
        const m = /\/api\/subproduct\/[^/]+\/price\/([\d,]+)/.exec(url);
        if (!m) return null;
        return new Response(JSON.stringify({ prices: Object.fromEntries(m[1].split(",").map((q) => [q, 68])) }), { status: 200 });
      }
      ```
    - em `clientComResposta`, troque o stub por `vi.stubGlobal("fetch", async (url: string) => vitrine(String(url)) ?? new Response(JSON.stringify(payload), { status: 200 }));`;
    - em `stubApi`, como primeira linha do `async (url: string) => {`: `const v = vitrine(String(url)); if (v) return v;`;
    - apague a linha 260 (`expect(r.produtos?.[0].sku).toBeTruthy();`) e tire `sku: string;` do tipo da linha 253.
  - `tests/buscarProdutosTool.test.ts`: rode o arquivo. Se alguma asserção ler `sku` ou `imagem_url` de `produtos[i]`, troque por uma asserção sobre `cartoes[i]` (`imagem_url` está no cartão). Se alguma conferir `OBSERVACAO_PRECOS` pelo texto literal, use a constante importada.

- [ ] **Passo 8: rodar tudo**

```bash
npm run typecheck
npx vitest run --maxWorkers=1 --minWorkers=1
```
Esperado: verde. Os testes de recomendação que usam `ClienteCatalogoFalso` continuam passando, porque a "vitrine" falsa devolve a tabela ao vivo. Se algum quebrar porque compara um preço de `ajustes` com o índice depois de `client.alterar(...)`, o esperado agora é o valor **ao vivo**: ajuste o teste.

- [ ] **Passo 9: commit**

```bash
git add -A src tests
git commit -m "feat(recomendacao): busca com o preço exato do site e cartões por produto"
```

---

### Tarefa 10: `detalhar_produto` com cotação exata e cartão

**Arquivos:**
- Modificar: `src/tools/detalharProduto.ts` e a descrição dele em `src/tools/index.ts`
- Teste: `tests/detalharProduto.test.ts` (acrescentar); reescrever 2 casos de `tests/precosPorCor.test.ts`; ajustar `tests/homologacao/recomendacao.test.ts:75-78` e `tests/contrato.test.ts:104,113`

**Interfaces:**
- Consome: `cotarAoVivo`, `cotou`, `guardarCotacoes` e `MAX_CORES_COTADAS`; `proximoDegrau`; `montarCartao`; `ehSobDemanda`.
- Produz: a saída de `detalhar_produto` **sem** `tabela_precos` e `precos_variam_por_cor`, e sem `sku` e `tabela_precos` por subproduto; com `cartoes: Cartao[]`; `preco_para_quantidade` (por cor) e `preco_para_quantidade_a_partir_de` vindos só da cotação exata; `aviso_estoque` quando nenhuma cor cobre a quantidade.

- [ ] **Passo 1: escrever o teste que falha** — acrescente a `tests/detalharProduto.test.ts` (imports novos: `setSobDemanda` de `../src/catalogo/sobDemanda.js`, `reais` de `../src/tools/prepararOrcamento.js`, e `afterEach` do vitest):

```ts
describe("detalhar_produto com o preço exato do site", () => {
  afterEach(() => setSobDemanda(null));

  it("com quantidade: cota só as cores que cobrem a quantidade e manda um cartão", async () => {
    const client = new MockBrindeMeClient();
    const state = createInitialState("5583999990000");
    const r = (await detalharProdutoHandler({ produto_id: "prod-003", quantidade: 100 }, state, client)) as {
      subprodutos_ativos: Array<{ cor: string; preco_para_quantidade: number | null }>;
      cartoes: Array<{ legenda: string; imagem_url: string | null }>;
      preco_para_quantidade_a_partir_de: number | null;
    };
    const porCor = Object.fromEntries(r.subprodutos_ativos.map((s) => [s.cor, s.preco_para_quantidade]));
    expect(porCor).toEqual({ Preta: 52, Branca: null });
    expect(r.preco_para_quantidade_a_partir_de).toBe(52);
    expect(r.cartoes).toHaveLength(1);
    expect(r.cartoes[0].legenda).toBe(
      ["*Garrafa Térmica Personalizada*", "Cores: Preta", `${reais(52)}/un para 100 un.`, `A partir de 200 un.: ${reais(46)}/un`].join("\n")
    );
    expect(state.cotacoes?.["sub-003-preta:100"]).toMatchObject({ centavos: 5200 });
  });

  it("sem quantidade: nenhuma tabela e nenhum preço; o cartão sai só com nome e cores", async () => {
    const r = (await detalharProdutoHandler({ produto_id: "prod-001" }, createInitialState("5583999990000"), new MockBrindeMeClient())) as Record<string, unknown> & {
      subprodutos_ativos: Array<Record<string, unknown>>;
      cartoes: Array<{ legenda: string }>;
    };
    expect(r.tabela_precos).toBeUndefined();
    expect(r.precos_variam_por_cor).toBeUndefined();
    expect(r.subprodutos_ativos.every((s) => s.tabela_precos === undefined && s.sku === undefined && s.preco_para_quantidade === null)).toBe(true);
    expect(r.preco_para_quantidade_a_partir_de).toBeNull();
    expect(r.cartoes[0].legenda).not.toMatch(/R\$/);
  });

  it("Foco da revisão 5: abaixo do mínimo não cota nem passa preço", async () => {
    const client = new MockBrindeMeClient();
    const espiao = vi.spyOn(client, "precoVenda");
    const r = (await detalharProdutoHandler({ produto_id: "prod-001", quantidade: 5 }, createInitialState("5583999990000"), client)) as {
      preco_para_quantidade_a_partir_de: number | null;
      min_quantity: number;
    };
    expect(espiao).not.toHaveBeenCalled();
    expect(r.preco_para_quantidade_a_partir_de).toBeNull();
    expect(r.min_quantity).toBe(25);
  });

  it("nenhuma cor cobre a quantidade: aviso de estoque oferecendo o humano; sob demanda ignora o estoque", async () => {
    const client = new MockBrindeMeClient();
    const semEstoque = (await detalharProdutoHandler({ produto_id: "prod-008", quantidade: 30 }, createInitialState("5583999990000"), client)) as { aviso_estoque?: string };
    expect(semEstoque.aviso_estoque).toMatch(/não tem no estoque/);
    setSobDemanda(["prod-008"]);
    const sobDemanda = (await detalharProdutoHandler({ produto_id: "prod-008", quantidade: 30 }, createInitialState("5583999990000"), client)) as {
      aviso_estoque?: string;
      cores_que_atendem_quantidade: string[];
    };
    expect(sobDemanda.aviso_estoque).toBeUndefined();
    expect(sobDemanda.cores_que_atendem_quantidade).toEqual(["Branca"]);
  });
});
```
(Se `vi` não estiver no import do vitest desse arquivo, acrescente.)

- [ ] **Passo 2: rodar e ver falhar** — `npx vitest run tests/detalharProduto.test.ts --maxWorkers=1 --minWorkers=1` → FAIL.

- [ ] **Passo 3: implementar** — substitua o conteúdo de `src/tools/detalharProduto.ts` por:

```ts
import { z } from "zod";
import type { BrindeMeClient } from "../integrations/brindeme/client.js";
import { ApiError, translateApiError } from "../integrations/brindeme/errors.js";
import { discutirProduto, lembrarDetalhado, type ConversationState } from "../agent/state.js";
import { cotarAoVivo, cotou, guardarCotacoes, MAX_CORES_COTADAS } from "../catalogo/cotacao.js";
import { proximoDegrau } from "../catalogo/faixasDeVenda.js";
import { ehSobDemanda } from "../catalogo/sobDemanda.js";
import { montarCartao, type Cartao } from "./cartao.js";

export const detalharProdutoSchema = z.object({
  produto_id: z.string().describe("ID do produto"),
  quantidade: z.number().int().positive().optional().describe("Quantidade desejada para calcular o preço"),
});

export type DetalharProdutoInput = z.infer<typeof detalharProdutoSchema>;

const AVISO_ESTOQUE =
  "Nenhuma cor tem estoque para essa quantidade. Diga que não tem no estoque e ofereça o atendimento humano para confirmar (transferir_humano com motivo outro se ele aceitar). Nunca mude a quantidade sem ele pedir.";

export async function detalharProdutoHandler(
  input: DetalharProdutoInput,
  state: ConversationState,
  client: BrindeMeClient
) {
  try {
    const p = await client.getProduct(input.produto_id);
    const activeSubs = p.subproducts.filter((s) => s.status);
    const sobDemanda = ehSobDemanda(p.id);
    const q = input.quantidade;

    // Guarda de onde veio cada subproduto: preparar_orcamento precisa disso
    // para resolver o item sem varrer o catálogo inteiro.
    for (const s of p.subproducts) state.subprodutoParaProduto[s.id] = p.id;
    discutirProduto(state, p.id, p.name);
    lembrarDetalhado(state, { id: p.id, nome: p.name, cores: activeSubs.map((s) => ({ subproduto_id: s.id, cor: s.color })) });

    const atende = (s: (typeof activeSubs)[number]) => sobDemanda || (q ? s.stock >= q : s.stock > 0);
    const disponiveis = activeSubs.filter(atende);
    const precos = new Map<string, number>();
    let cotadas: Array<{ cor: string; cotacao: Awaited<ReturnType<typeof cotarAoVivo>>[number] }> = [];
    if (q && q >= p.min_quantity) {
      const aCotar = disponiveis.slice(0, MAX_CORES_COTADAS);
      const cotacoes = await cotarAoVivo(client, aCotar.map((s) => ({ subprodutoId: s.id, quantidade: q, proximoDegrau: proximoDegrau(s.prices, q) })));
      guardarCotacoes(state, cotacoes);
      for (const c of cotacoes) if (cotou(c) && c.centavos > 0) precos.set(c.subproduto_id, c.centavos / 100);
      cotadas = aCotar.map((s, i) => ({ cor: s.color, cotacao: cotacoes[i] }));
    }

    const subprodutos = activeSubs.map((s) => ({
      subproduto_id: s.id,
      cor: s.color,
      estoque: s.stock,
      disponivel: sobDemanda || s.stock > 0,
      preco_para_quantidade: precos.get(s.id) ?? null,
      // O modelo errou a conta (112 ≥ 100) e transferiu: a comparação sai pronta.
      atende_quantidade: q ? atende(s) : null,
    }));

    const cartoes: Cartao[] = [
      montarCartao({
        produto_id: p.id,
        nome: p.name,
        imagem_url: p.images[0]?.url ?? null,
        quantidade: cotadas.length ? q : undefined,
        cotadas,
        outras: disponiveis.slice(cotadas.length).map((s) => s.color),
      }),
    ];

    return {
      id: p.id,
      nome: p.name,
      descricao: p.description,
      min_quantity: p.min_quantity,
      subprodutos_ativos: subprodutos,
      cores_que_atendem_quantidade: q ? subprodutos.filter((s) => s.atende_quantidade).map((s) => s.cor) : null,
      ...(q && disponiveis.length === 0 ? { aviso_estoque: AVISO_ESTOQUE } : {}),
      preco_para_quantidade_a_partir_de: precos.size ? Math.min(...precos.values()) : null,
      ...(q ? {} : { aviso: "Sem a quantidade não há preço: pergunte quantas unidades." }),
      imagens: p.images.map((i) => i.url),
      personalizacoes: p.customizations.map((c) => `${c.type}: ${c.description}`),
      cartoes,
    };
  } catch (err) {
    // Id inventado pelo modelo não é a API fora do ar: não conta para a transferência por falha.
    if (err instanceof ApiError && err.status === 404) {
      return {
        resultado: "produto_nao_encontrado" as const,
        instrucao_ao_agente: "Esse produto_id não existe. Ache o produto com buscar_produtos e use o id que ele devolver; nunca invente id.",
      };
    }
    return { erro: translateApiError(err) };
  }
}
```

- [ ] **Passo 4: descrição** — em `src/tools/index.ts`, `description` de `detalhar_produto`:

  `"Retorna detalhes de um produto: cores ativas, estoque, personalizações e, com quantidade, o preço exato do site de cada cor. O sistema envia ao cliente um cartão com foto (cartoes); não repita o que está nele. Use quando o cliente pedir mais informações sobre um produto específico, com o id que veio de buscar_produtos. Com quantidade, diga quais cores cobrem o pedido pelo campo cores_que_atendem_quantidade, sem comparar estoque de cabeça."`

- [ ] **Passo 5: testes antigos**
  - `tests/precosPorCor.test.ts`: apague os dois `it` das linhas 42-71 ("cada subproduto carrega a própria tabela de preços" e "mantém tabela única quando todas as cores custam igual") e ponha no lugar:
    ```ts
      it("sem quantidade não sai preço nenhum: o preço só vem da cotação exata", async () => {
        const r = (await detalharProdutoHandler({ produto_id: comPrecosDistintos.id }, state, client)) as Record<string, unknown> & {
          subprodutos_ativos: Array<{ preco_para_quantidade: number | null }>;
        };
        expect(r.tabela_precos).toBeUndefined();
        expect(r.subprodutos_ativos.every((s) => s.preco_para_quantidade === null)).toBe(true);
      });
    ```
    `comPrecoUniforme` fica sem uso: apague a constante e o `it` "os mocks realmente têm produto com preço variando por cor" passa a conferir só `comPrecosDistintos`.
  - `tests/homologacao/recomendacao.test.ts`: apague a linha 78 (`expect(r.precos_variam_por_cor).toBe(true);`) e o campo `precos_variam_por_cor: boolean;` do tipo da linha 75.
  - `tests/contrato.test.ts`: apague a linha 113 (`expect(r.subprodutos_ativos[0].sku).toBeTruthy();`) e `sku: string;` do tipo da linha 104.

- [ ] **Passo 6: rodar tudo** — `npm run typecheck` e `npx vitest run --maxWorkers=1 --minWorkers=1` → verde.

- [ ] **Passo 7: commit**

```bash
git add -A src tests
git commit -m "feat(detalhe): detalhar_produto com preço exato do site e cartão"
```

---

### Tarefa 11: `preparar_orcamento` com a cotação exata

**Arquivos:**
- Modificar: `src/tools/prepararOrcamento.ts`
- Teste: `tests/prepararOrcamento.test.ts` (acrescentar); ajustar `tests/homologacao/recomendacao.test.ts:138`

**Interfaces:**
- Consome: `cotacaoValida`, `cotarAoVivo`, `cotou`, `guardarCotacoes` e `Cotacao`; `ehSobDemanda`.
- Produz: o erro `{ erro: "preco_indisponivel", subproduto_id, quantidade_solicitada, instrucao: "transferir", motivo_sugerido: "outro", mensagem }`. O `runTurn` já força a transferência quando vê `instrucao: "transferir"`.

- [ ] **Passo 1: escrever o teste que falha** — acrescente a `tests/prepararOrcamento.test.ts` (ajuste os imports: `MockBrindeMeClient`, `createInitialState`, `prepararOrcamentoHandler`, `vi`, `afterEach`, `setSobDemanda`):

```ts
describe("preparar_orcamento com o preço exato do site", () => {
  const entrada = (quantidade = 50) => ({ tipo: "PF" as const, nome: "João Silva", email: "joao@teste.com", itens: [{ subproduto_id: "sub-001-branco", quantidade }] });
  const comMapa = () => {
    const state = createInitialState("5583999990000");
    state.subprodutoParaProduto["sub-001-branco"] = "prod-001";
    return state;
  };
  afterEach(() => setSobDemanda(null));

  it("reaproveita a cotação válida da conversa sem chamar o site de novo", async () => {
    const client = new MockBrindeMeClient();
    const espiao = vi.spyOn(client, "precoVenda");
    const state = comMapa();
    state.cotacoes = { "sub-001-branco:50": { subproduto_id: "sub-001-branco", quantidade: 50, centavos: 2000, fonte: "site", em: new Date().toISOString() } };
    const r = (await prepararOrcamentoHandler(entrada(), state, client)) as { resumo: { itens: Array<{ preco_unitario: number; subtotal: number }> } };
    expect(espiao).not.toHaveBeenCalled();
    expect(r.resumo.itens[0]).toMatchObject({ preco_unitario: 20, subtotal: 1000 });
  });

  it("cota de novo com mais de 1 h, com outra quantidade ou com fonte que não é site", async () => {
    const client = new MockBrindeMeClient();
    const espiao = vi.spyOn(client, "precoVenda");
    const velha = new Date(Date.now() - 2 * 3_600_000).toISOString();
    for (const cotacoes of [
      { "sub-001-branco:50": { subproduto_id: "sub-001-branco", quantidade: 50, centavos: 1, fonte: "site" as const, em: velha } },
      { "sub-001-branco:60": { subproduto_id: "sub-001-branco", quantidade: 60, centavos: 1, fonte: "site" as const, em: new Date().toISOString() } },
      { "sub-001-branco:50": { subproduto_id: "sub-001-branco", quantidade: 50, centavos: 1, fonte: "indice" as "site", em: new Date().toISOString() } },
    ]) {
      const state = comMapa();
      state.cotacoes = cotacoes;
      const r = (await prepararOrcamentoHandler(entrada(), state, client)) as { resumo: { itens: Array<{ preco_unitario: number }> } };
      expect(r.resumo.itens[0].preco_unitario).toBe(18.9);
    }
    expect(espiao).toHaveBeenCalledTimes(3);
  });

  it("sem preço (rota fora ou 'a consultar'): preco_indisponivel com a instrução de transferir", async () => {
    const fora = new MockBrindeMeClient();
    fora.falharPrecoVenda = true;
    const r1 = await prepararOrcamentoHandler(entrada(), comMapa(), fora);
    expect(r1).toMatchObject({ erro: "preco_indisponivel", instrucao: "transferir", motivo_sugerido: "outro" });

    const semLimite = new (class extends MockBrindeMeClient {
      async getProduct(id: string) {
        const p = await super.getProduct(id);
        return { ...p, subproducts: p.subproducts.map((s) => ({ ...s, stock: 100_000 })) };
      }
    })();
    const r2 = await prepararOrcamentoHandler(entrada(10_000), comMapa(), semLimite);
    expect(r2).toMatchObject({ erro: "preco_indisponivel" });
  });

  it("sob demanda passa com estoque 0; sem estoque em nenhuma cor oferece o humano", async () => {
    const client = new MockBrindeMeClient();
    const state = createInitialState("5583999990000");
    state.subprodutoParaProduto["sub-008-branca"] = "prod-008";
    const item = { tipo: "PF" as const, nome: "João Silva", email: "joao@teste.com", itens: [{ subproduto_id: "sub-008-branca", quantidade: 30 }] };
    const sem = (await prepararOrcamentoHandler(item, state, client)) as { erro: string; instrucao: string };
    expect(sem.erro).toBe("estoque_insuficiente");
    expect(sem.instrucao).toMatch(/não tem no estoque/);
    setSobDemanda(["prod-008"]);
    expect(await prepararOrcamentoHandler(item, state, client)).toMatchObject({ status: "estimativa_pronta" });
  });
});
```

- [ ] **Passo 2: rodar e ver falhar** → FAIL.

- [ ] **Passo 3: implementar** em `src/tools/prepararOrcamento.ts`:
  - Imports:
    ```ts
    import { cotacaoValida, cotarAoVivo, cotou, guardarCotacoes, type Cotacao } from "../catalogo/cotacao.js";
    import { ehSobDemanda } from "../catalogo/sobDemanda.js";
    ```
  - No ramo `informe_a_cor`, troque `.filter((s) => s.status && s.stock > 0)` por `.filter((s) => s.status && (ehSobDemanda(produto.id) || s.stock > 0))`.
  - Troque o bloco `if (sub.stock < item.quantidade) { ... }` por:
    ```ts
          const sobDemanda = ehSobDemanda(p.id);
          if (!sobDemanda && sub.stock < item.quantidade) {
            const coresQueAtendem = p.subproducts
              .filter((s) => s.status && s.stock >= item.quantidade)
              .map((s) => ({ subproduto_id: s.id, cor: s.color }));
            // Sem a cor e as alternativas, o modelo chutava a cor no texto e inventava outra quantidade (25/10).
            return {
              erro: "estoque_insuficiente",
              subproduto_id: item.subproduto_id,
              cor: sub.color,
              estoque_disponivel: sub.stock,
              quantidade_solicitada: item.quantidade,
              cores_que_atendem: coresQueAtendem,
              instrucao: coresQueAtendem.length
                ? "Diga ao cliente qual cor não tem estoque. Se ele aceitou qualquer cor, prepare de novo com uma de cores_que_atendem; senão, ofereça essas cores. Nunca mude a quantidade sem ele pedir."
                : "Nenhuma cor tem estoque para essa quantidade. Diga que não tem no estoque e ofereça o atendimento humano para confirmar (transferir_humano com motivo outro se ele aceitar). Nunca mude a quantidade sem ele pedir.",
            };
          }
    ```
  - Troque o bloco que vai de `const range = sub.prices.find(` até `const price = range.price;` (já sem `p.price` desde a Tarefa 3) por:
    ```ts
          const cotacao = cotacaoValida(state, item.subproduto_id, item.quantidade) ?? (await cotarUma(client, state, item.subproduto_id, item.quantidade));
          if (!cotacao || cotacao.centavos === 0) {
            return {
              erro: "preco_indisponivel",
              subproduto_id: item.subproduto_id,
              quantidade_solicitada: item.quantidade,
              instrucao: "transferir",
              motivo_sugerido: "outro",
              mensagem: "O site não deu o preço desta cor nesta quantidade: quem fecha o valor é a equipe.",
            };
          }
          const price = cotacao.centavos / 100;
    ```
  - Ao fim do arquivo:
    ```ts
    async function cotarUma(client: BrindeMeClient, state: ConversationState, subprodutoId: string, quantidade: number): Promise<Cotacao | undefined> {
      const [r] = await cotarAoVivo(client, [{ subprodutoId, quantidade }]);
      guardarCotacoes(state, [r]);
      return cotou(r) ? r : undefined;
    }
    ```
  - Na descrição de `preparar_orcamento` em `src/tools/index.ts`, troque `"Valida os itens (cor, estoque, quantidade mínima, faixa de preço) e calcula a estimativa de tabela"` por `"Valida os itens (cor, estoque, quantidade mínima) e calcula a estimativa com o preço exato do site"`.

- [ ] **Passo 4: teste antigo** — em `tests/homologacao/recomendacao.test.ts:138`, troque `expect(r.erro).toBe("sem_faixa_de_preco");` por `expect(r.erro).toBe("preco_indisponivel");` e ajuste o comentário da linha 125 para `// 10.000 canecas: fora de toda faixa, o site diz "a consultar" (0) e quem fecha é a equipe.`

- [ ] **Passo 5: rodar tudo** — `npm run typecheck` e `npx vitest run --maxWorkers=1 --minWorkers=1` → verde.

- [ ] **Passo 6: commit**

```bash
git add -A src tests
git commit -m "feat(orcamento): estimativa com a cotação exata do site, válida por 1 h"
```

---

### Tarefa 12: contrato com imagem, cartões no turno e prompt

**Arquivos:**
- Modificar: `src/contrato/esquemas.ts`, `src/tools/cartao.ts`, `src/agent/runTurn.ts`, `src/api/agenteDefinitivo.ts`, `src/duble/direto.ts`, `evals/runEvals.ts:72-89` e `src/agent/prompt/system.md:115,118`
- Teste: `tests/cartoesNoTurno.test.ts`; ajustar `tests/ponteRegressoes.test.ts:231`

**Interfaces:**
- Produz: `itemRespostaSchema`, `type ItemResposta = string | { imagem_url: string; legenda: string }`, `respostaMensagensSchema.respostas: ItemResposta[]`, `TurnResult.cartoes?: Cartao[]` e `itensDosCartoes(cartoes: Cartao[]): ItemResposta[]`.

- [ ] **Passo 1: escrever o teste que falha** — `tests/cartoesNoTurno.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { runTurn } from "../src/agent/runTurn.js";
import { createInitialState } from "../src/agent/state.js";
import { MockBrindeMeClient } from "../src/integrations/brindeme/mockClient.js";
import { Logger } from "../src/logging/logger.js";
import { itensDosCartoes } from "../src/tools/cartao.js";
import { respostaMensagensSchema } from "../src/contrato/esquemas.js";
import { setProductIndexStore, setOccasionTagStore } from "../src/tools/buscarProdutos.js";
import { usarIndiceDoMock } from "./helpers/catalogo.js";
import { ScriptedLLM, endTurn, toolUse } from "./helpers/llmRoteirizado.js";

describe("cartões no turno", () => {
  afterEach(() => {
    setProductIndexStore(null);
    setOccasionTagStore(null);
  });

  it("buscar_produtos devolve os cartões no TurnResult, e o histórico guarda o que o cliente viu", async () => {
    await usarIndiceDoMock();
    const state = createInitialState("5583999990000");
    const llm = new ScriptedLLM([toolUse("buscar_produtos", { consulta: "caneca", quantidade: 50 }), endTurn("Qual delas te agrada?")]);
    const r = await runTurn("quero 50 canecas", state, llm, new MockBrindeMeClient(), new Logger(state.conversaId));
    expect(r.response).toBe("Qual delas te agrada?");
    expect(r.cartoes?.length).toBeGreaterThan(0);
    expect(r.cartoes![0].legenda).toMatch(/^\*Caneca de Porcelana Personalizada\*/);
    const ultima = state.historico.at(-1)!;
    expect(ultima.role).toBe("assistant");
    expect(ultima.content.startsWith(r.cartoes![0].legenda)).toBe(true);
    expect(ultima.content.endsWith("Qual delas te agrada?")).toBe(true);
  });

  it("buscar de novo troca os cartões; detalhar acrescenta ou substitui o do mesmo produto", async () => {
    await usarIndiceDoMock();
    const state = createInitialState("5583999990000");
    const llm = new ScriptedLLM([
      toolUse("buscar_produtos", { consulta: "caneca", quantidade: 50 }),
      toolUse("buscar_produtos", { consulta: "garrafa", quantidade: 50 }),
      toolUse("detalhar_produto", { produto_id: "prod-003", quantidade: 50 }),
      endTurn("Essa é a garrafa."),
    ]);
    const r = await runTurn("quero 50 garrafas", state, llm, new MockBrindeMeClient(), new Logger(state.conversaId));
    expect(r.cartoes!.filter((c) => c.produto_id === "prod-003")).toHaveLength(1);
    expect(r.cartoes!.some((c) => c.produto_id === "prod-001")).toBe(false);
  });

  it("Foco da revisão 2: cartão sem imagem ou com URL inválida vira texto; com URL https, foto", () => {
    const itens = itensDosCartoes([
      { produto_id: "a", imagem_url: "https://cdn.brinde.me/a.webp", legenda: "A" },
      { produto_id: "b", imagem_url: null, legenda: "B" },
      { produto_id: "c", imagem_url: "/storage/c.webp", legenda: "C" },
    ]);
    expect(itens).toEqual([{ imagem_url: "https://cdn.brinde.me/a.webp", legenda: "A" }, "B", "C"]);
    expect(respostaMensagensSchema.parse({ respostas: [...itens, "texto"], modo: "ia" }).respostas).toHaveLength(4);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar** → FAIL.

- [ ] **Passo 3: contrato** — em `src/contrato/esquemas.ts`, acima de `respostaMensagensSchema`:

```ts
/** Texto ou foto com legenda (cartão de produto). */
export const itemRespostaSchema = z.union([
  z.string(),
  z.object({ imagem_url: z.string().url(), legenda: z.string().max(LIMITE_TEXTO) }),
]);
```
Em `respostaMensagensSchema`, troque `respostas: z.array(z.string()),` por `respostas: z.array(itemRespostaSchema),`. No fim do arquivo: `export type ItemResposta = z.infer<typeof itemRespostaSchema>;`

- [ ] **Passo 4: `itensDosCartoes`** — ao fim de `src/tools/cartao.ts`, com `import type { ItemResposta } from "../contrato/esquemas.js";` no topo:

```ts
const urlDeImagem = (u: string | null): u is string => !!u && /^https?:\/\//i.test(u) && URL.canParse(u);

/** URL ruim derrubaria o parse da resposta na ponte e o turno inteiro: aí o cartão vai como texto. */
export function itensDosCartoes(cartoes: Cartao[]): ItemResposta[] {
  return cartoes.map((c) => (urlDeImagem(c.imagem_url) ? { imagem_url: c.imagem_url, legenda: c.legenda } : c.legenda));
}
```

- [ ] **Passo 5: `runTurn.ts`**
  - Import: `import type { Cartao } from "../tools/cartao.js";`
  - Em `TurnResult`, depois de `lacunas: string[];`:
    ```ts
      /** Cartões de produto do turno (foto + legenda): a ponte envia antes do texto. */
      cartoes?: Cartao[];
    ```
  - Junto de `const lacunas: string[] = [];`, declare `let cartoes: Cartao[] = [];` e acrescente em `resultado`: `...(cartoes.length ? { cartoes } : {}),`.
  - Logo depois do `logger.log({ type: "tool_call", ... });` dentro do laço das ferramentas:
    ```ts
            const daFerramenta = (output as { cartoes?: Cartao[] } | null)?.cartoes;
            if (Array.isArray(daFerramenta)) {
              // Busca nova troca a vitrine do turno; detalhe acrescenta ou substitui o cartão do mesmo produto.
              cartoes =
                toolName === "buscar_produtos"
                  ? daFerramenta
                  : [...cartoes.filter((c) => !daFerramenta.some((n) => n.produto_id === c.produto_id)), ...daFerramenta];
            }
    ```
  - Troque `if (text) addMessage(state, "assistant", text);` por:
    ```ts
          // O histórico guarda o que o cliente viu: o modelo do turno seguinte e o CRM leem os cartões daqui.
          const visto = [...cartoes.map((c) => c.legenda), text].filter(Boolean).join("\n\n");
          if (visto) addMessage(state, "assistant", visto);
    ```

- [ ] **Passo 6: quem monta `respostas`**
  - `src/api/agenteDefinitivo.ts`: import `import { itensDosCartoes } from "../tools/cartao.js";`. Troque as duas ocorrências de `respostas: formatarParaWhatsApp(r.response),` por `respostas: [...itensDosCartoes(r.cartoes ?? []), ...formatarParaWhatsApp(r.response)],`.
  - `src/duble/direto.ts`: mesmo import (`../tools/cartao.js`). Troque `respostas: formatarParaWhatsApp(resultado.response ?? ""),` por `respostas: [...itensDosCartoes(resultado.cartoes ?? []), ...formatarParaWhatsApp(resultado.response ?? "")],`.
  - `evals/runEvals.ts`: a função `turnoPelaApi` passa a devolver `Promise<TurnResult & { textoDoModelo?: string | null }>`, e a última linha fica:
    ```ts
      return {
        ...bruto,
        textoDoModelo: bruto.response,
        response: resposta.respostas.map((i) => (typeof i === "string" ? i : i.legenda)).join("\n\n") || null,
      };
    ```
    (O uso de `textoDoModelo` vem na Tarefa 16.)
  - `tests/ponteRegressoes.test.ts:231`: troque `resposta.respostas.flatMap((r) => r.split("\n"))` por `resposta.respostas.flatMap((r) => (typeof r === "string" ? r.split("\n") : [r]))`.

- [ ] **Passo 7: prompt** — em `src/agent/prompt/system.md`:
  - Troque a linha 115 inteira (regra 4) por:
    `4. **Os cartões já vão ao cliente.** \`buscar_produtos\` e \`detalhar_produto\` devolvem \`cartoes\`, e o sistema envia cada um como foto com legenda (nome, cores, preço e condição para mais unidades) **antes** do seu texto. Não repita nome, preço, cores nem condição: escreva uma ou duas frases que apresentem as opções e perguntem qual agrada ou qual cor. Cite só produtos que vieram da ferramenta. Se nenhum resultado é o tipo de produto que o cliente pediu (ex.: pediu caneca e vieram xícaras), diga isso. Diga que personalização, frete e condições especiais são confirmados no orçamento. Cartão com "Valor a confirmar com a equipe": a equipe confirma o preço; se o cliente quiser fechar esse produto, transfira.`
  - No fim da linha 118 (regra 6), acrescente: ` Se o que não fechou foi o estoque, diga que não tem no estoque para essa quantidade e ofereça o atendimento humano para confirmar.`

- [ ] **Passo 8: rodar tudo** — `npm run typecheck` e `npx vitest run --maxWorkers=1 --minWorkers=1`. Esperado: verde. Se o typecheck reclamar de algum teste que usa `respostas[i]` como string (`.includes`, `.split`, `.startsWith`), aplique a mesma guarda `typeof r === "string"` do passo 6.

- [ ] **Passo 9: commit**

```bash
git add -A src tests evals
git commit -m "feat(contrato): cartões de produto saem como foto antes do texto"
```

---

### Tarefa 13: ponte envia a foto, com recuo para texto

**Arquivos:**
- Modificar: `src/whatsapp/canal.ts`, `src/whatsapp/sessao.ts`, `src/whatsapp/envio.ts`, `src/whatsapp/ponte.ts:171-180,354-391` e `src/whatsapp/estadoPonte.ts:7-10,83-92`; `tests/helpers/whatsappFalso.ts`; o mock de `tests/sessao.test.ts`
- Teste: `tests/envio.test.ts`, `tests/observadorPonte.test.ts`, `tests/sessao.test.ts` e `tests/estadoPonte.test.ts` (acrescentar)

**Interfaces:**
- Consome: `ItemResposta` e `itemRespostaSchema` (Tarefa 12).
- Produz: `CanalWhatsApp.enviarImagem(chatId: string, url: string, legenda: string): Promise<void>`, `Envio.paraCliente(telefone, chatId, item: ItemResposta, continuar?)`, `Envio.imagemDe(chave, texto): string | undefined`, `RegistroSaida.registrar(chave, texto, imagemUrl?)` e `EntregaParcial.partes: ItemResposta[]`.

- [ ] **Passo 1: canal falso** — em `tests/helpers/whatsappFalso.ts`, acrescente à classe:

```ts
  imagens: Array<{ chatId: string; url: string; legenda: string }> = [];
  /** url → quantas das próximas tentativas de enviar essa imagem falham */
  falharImagem = new Map<string, number>();

  async enviarImagem(chatId: string, url: string, legenda: string): Promise<void> {
    const restantes = this.falharImagem.get(url) ?? 0;
    if (restantes > 0) {
      this.falharImagem.set(url, restantes - 1);
      throw new Error("falha de envio de imagem simulada");
    }
    this.imagens.push({ chatId, url, legenda });
    // Como o whatsapp-web.js: o eco da foto chega com a legenda no corpo.
    this.handler(this.mensagem({ chatId, texto: legenda, deMim: true, paraMim: chatId === this.eu, tipo: "midia" }));
  }
```

- [ ] **Passo 2: escrever os testes que falham**

`tests/envio.test.ts`, dentro do `describe("envio")`:

```ts
  it("foto: sai como imagem com legenda, e o eco (a legenda) é reconhecido como nosso", async () => {
    const canal = new WhatsAppFalso();
    const envio = new Envio(canal, 20);
    const ecos: boolean[] = [];
    canal.aoMensagem((m) => ecos.push(envio.ehMinha(m.telefone!, m.texto)));
    const foto = { imagem_url: "https://cdn.brinde.me/x.webp", legenda: "*Caneca*" };
    const enviado = envio.paraCliente("5583999990000", CLIENTE, foto);
    await vi.runAllTimersAsync();
    expect(await enviado).toBe(true);
    expect(canal.imagens).toEqual([{ chatId: CLIENTE, url: foto.imagem_url, legenda: "*Caneca*" }]);
    expect(canal.enviadas).toEqual([]);
    expect(ecos).toEqual([true]);
  });

  it("foto que falha: a legenda vai como texto", async () => {
    const canal = new WhatsAppFalso();
    const envio = new Envio(canal, 20);
    canal.falharImagem.set("https://cdn.brinde.me/x.webp", 1);
    const enviado = envio.paraCliente("5583999990000", CLIENTE, { imagem_url: "https://cdn.brinde.me/x.webp", legenda: "*Caneca*" });
    await vi.runAllTimersAsync();
    expect(await enviado).toBe(true);
    expect(canal.imagens).toEqual([]);
    expect(canal.enviadas.map((e) => e.texto)).toEqual(["*Caneca*"]);
  });

  it("imagemDe devolve a URL da foto registrada com aquela legenda, sem consumir", () => {
    const r = new RegistroSaida();
    r.registrar("5583999990000", "*Caneca*", "https://cdn.brinde.me/x.webp");
    expect(r.imagemDe("5583999990000", "*Caneca*")).toBe("https://cdn.brinde.me/x.webp");
    expect(r.consumir("5583999990000", "*Caneca*")).toBe(true);
  });
```

`tests/observadorPonte.test.ts`, dentro do `describe` existente:

```ts
  it("Foco da revisão 1: o eco da foto da IA é AGENTE, leva a URL ao CRM e não pausa a IA", async () => {
    const { canal, agente, ponte, vistas } = montar();
    const foto = { imagem_url: "https://cdn.brinde.me/x.webp", legenda: "*Caneca*" };
    agente.padrao = { tipo: "ok", resposta: { respostas: [foto, "Gostou?"], modo: "ia" } };
    await ponte.receber(canal.mensagem({ chatId: CLIENTE, texto: "quero canecas" }));
    await vi.runAllTimersAsync();
    expect(canal.imagens.map((i) => i.url)).toEqual([foto.imagem_url]);
    expect(vistas.map((v) => [v.autor, v.texto])).toEqual([
      ["CLIENTE", "quero canecas"],
      ["AGENTE", "*Caneca*\nhttps://cdn.brinde.me/x.webp"],
      ["AGENTE", "Gostou?"],
    ]);
    expect(agente.eventos).toEqual([]);
  });
```

`tests/estadoPonte.test.ts`: acrescente um caso que grava, com `ArquivoEstadoPonte`, um `entregasParciais` com `partes: [{ imagem_url: "https://cdn.brinde.me/x.webp", legenda: "L" }, "texto"]`, lê de volta e espera as mesmas partes. Copie a montagem (arquivo temporário, `salvar`, `carregar`) do teste que já existe na linha 32, que confere a entrada inválida.

`tests/sessao.test.ts`:
- no `vi.hoisted` do `controle`, acrescente `midias: [] as unknown[][],`;
- no `return` do `vi.mock`, troque `{ default: { Client: ClienteFalso, LocalAuth: class {} } }` por:
  ```ts
  {
    default: {
      Client: ClienteFalso,
      LocalAuth: class {},
      MessageMedia: { fromUrl: async (...args: unknown[]) => (controle.midias.push(args), { midia: args[0] }) },
    },
  }
  ```
- e o teste:
  ```ts
  it("foto: fromUrl com unsafeMime e sendMessage com caption, sem marcar como lida", async () => {
    const canal = await montar();
    await canal.enviarImagem(`${TEL}@c.us`, "https://cdn.brinde.me/x.webp", "*Caneca*");
    expect(controle.midias).toEqual([["https://cdn.brinde.me/x.webp", { unsafeMime: true }]]);
    expect(controle.envios.at(-1)).toEqual([`${TEL}@c.us`, { midia: "https://cdn.brinde.me/x.webp" }, { caption: "*Caneca*", sendSeen: false }]);
  });
  ```
  (Se `controle.envios` e `controle.midias` não são zerados entre testes, zere-os no `beforeEach` existente do arquivo, junto dos outros campos.)

- [ ] **Passo 3: rodar e ver falhar** — `npx vitest run tests/envio.test.ts tests/observadorPonte.test.ts tests/sessao.test.ts tests/estadoPonte.test.ts --maxWorkers=1 --minWorkers=1` → FAIL.

- [ ] **Passo 4: canal** — em `src/whatsapp/canal.ts`, dentro de `CanalWhatsApp`, depois de `enviar(...)`:

```ts
  /** Foto com legenda. O .webp do CDN chega como foto; como documento, não chega (sonda de 05/11). */
  enviarImagem(chatId: string, url: string, legenda: string): Promise<void>;
```

- [ ] **Passo 5: sessão** — em `src/whatsapp/sessao.ts`, troque `const { Client, LocalAuth } = wwebjs;` por `const { Client, LocalAuth, MessageMedia } = wwebjs;` e acrescente, depois de `enviar`:

```ts
  async enviarImagem(chatId: string, url: string, legenda: string): Promise<void> {
    // Sonda de 05/11: assim o webp do CDN chega como foto, com a legenda inteira.
    const midia = await MessageMedia.fromUrl(url, { unsafeMime: true });
    const enviada = await this.exigirCliente().sendMessage(chatId, midia, { caption: legenda, sendSeen: false });
    if (!enviada) throw new Error(`WhatsApp não encontrou a conversa ${chatId}`);
  }
```

- [ ] **Passo 6: envio** — em `src/whatsapp/envio.ts`:
  - Import: `import type { ItemResposta } from "../contrato/esquemas.js";`
  - Em `RegistroSaida`: o tipo de `pendentes` ganha `imagemUrl?: string`. `registrar(chave: string, texto: string, imagemUrl?: string): Saida` faz o push com `imagemUrl`. Novo método:
    ```ts
      /** URL da foto que saiu com esta legenda, sem tirar do registro. */
      imagemDe(chave: string, texto: string): string | undefined {
        const agora = Date.now();
        return this.pendentes.find((p) => p.chave === chave && p.texto === texto.trim() && agora - p.em <= this.validadeMs)?.imagemUrl;
      }
    ```
  - Em `Envio`:
    ```ts
      imagemDe(chave: string, texto: string): string | undefined {
        return this.registro.imagemDe(chave, texto);
      }

      /** `continuar` é conferido logo antes de cada tentativa sair; false cancela o envio (devolve false). */
      paraCliente(telefone: string, chatId: string, item: ItemResposta, continuar: () => boolean = () => true): Promise<boolean> {
        return typeof item === "string"
          ? this.enviar(telefone, chatId, item, true, continuar)
          : this.enviarFoto(telefone, chatId, item, continuar);
      }

      /** Uma tentativa de foto. Se falhar, a legenda vai como texto, com a nova tentativa do texto. */
      private async enviarFoto(
        chave: string,
        chatId: string,
        foto: { imagem_url: string; legenda: string },
        continuar: () => boolean
      ): Promise<boolean> {
        await this.canal.digitando(chatId).catch(() => {});
        await esperar(tempoDigitando(foto.legenda));
        await this.limitador.aguardarVez();
        if (!continuar()) return false;
        // Registra antes de enviar: o eco da foto (a legenda) chega antes do envio resolver.
        const saida = this.registro.registrar(chave, foto.legenda, foto.imagem_url);
        try {
          await this.canal.enviarImagem(chatId, foto.imagem_url, foto.legenda);
          return true;
        } catch (err) {
          this.log({ type: "foto_falhou", erro: String(err) });
          if (saida.confirmada) return true;
          return this.enviar(chave, chatId, foto.legenda, false, continuar);
        }
      }
    ```
    (Apague a versão antiga de `paraCliente`.)

- [ ] **Passo 7: ponte** — em `src/whatsapp/ponte.ts`:
  - Import: `import type { ItemResposta } from "../contrato/esquemas.js";`
  - Acima da classe: `const mesmaParte = (a: ItemResposta | undefined, b: ItemResposta) => JSON.stringify(a) === JSON.stringify(b);`
  - Na linha 381, troque `resposta.respostas[jaSaiu] === parcial.partes[jaSaiu]` por `mesmaParte(resposta.respostas[jaSaiu], parcial.partes[jaSaiu])`.
  - Em `observar`, troque a chamada `observador.mensagem({ ... texto: m.texto, ... })` por:
    ```ts
          const foto = m.deMim ? this.envio.imagemDe(m.telefone, m.texto) : undefined;
          observador.mensagem({ id: m.id, telefone: m.telefone, autor, tipo: m.tipo, texto: foto ? `${m.texto}\n${foto}` : m.texto, timestamp: m.timestamp });
    ```

- [ ] **Passo 8: estado da ponte** — em `src/whatsapp/estadoPonte.ts`:
  - Import: `import { z } from "zod";` e acrescente `ItemResposta` e `itemRespostaSchema` ao import de `../contrato/esquemas.js`.
  - `EntregaParcial.partes: ItemResposta[];`
  - Abaixo de `textos`: `const partesValidas = (v: unknown): v is ItemResposta[] => z.array(itemRespostaSchema).safeParse(v).success;`
  - Em `entregasValidas`, troque `textos(e?.partes)` por `partesValidas(e?.partes)`.

- [ ] **Passo 9: rodar tudo** — `npm run typecheck` e `npx vitest run --maxWorkers=1 --minWorkers=1` → verde.

- [ ] **Passo 10: commit**

```bash
git add -A src tests
git commit -m "feat(whatsapp): cartão sai como foto com legenda e cai para texto se falhar"
```

---

### Tarefa 14: produção nunca sobe em mock nem com o CRM desligado sem avisar

**Arquivos:**
- Criar: `src/operacao/exigirAmbiente.ts`
- Modificar: `src/config.ts:35-36`, `src/operacao/verificacaoAmbiente.ts:71-81`, `scripts/verificarEnv.ts`, `src/api/index.ts`, `src/duble/index.ts`, `src/whatsapp/index.ts` e `.env.example`
- Teste: `tests/operacao.test.ts` (ajustar `ENV_PILOTO` e acrescentar casos)

**Interfaces:**
- Produz: `levantarFatos(env?): FatosAmbiente`, `ehProducao(env?): boolean` e `exigirAmbiente(escopo: "agente" | "ponte", env?): void`.

- [ ] **Passo 1: escrever o teste que falha** — em `tests/operacao.test.ts`:
  - Acrescente a `ENV_PILOTO`: `CRM_URL: "https://crm.loja.com.br",` e `CRM_INTEGRATION_SECRET: "0123456789abcdef",`.
  - Imports: `vi` do vitest e `import { exigirAmbiente } from "../src/operacao/exigirAmbiente.js";`.
  - Dentro de `describe("verificar:env")`:
    ```ts
      it("sem BRINDEME_MODE: erro em produção, aviso em desenvolvimento", () => {
        const { BRINDEME_MODE: _, ...semModo } = ENV_PILOTO;
        expect(verificarAmbiente(semModo, FATOS_OK, { producao: true }).find((a) => a.item === "BRINDEME_MODE")?.gravidade).toBe("erro");
        expect(verificarAmbiente(semModo, FATOS_OK, { producao: false }).find((a) => a.item === "BRINDEME_MODE")?.gravidade).toBe("aviso");
      });

      it("CRM desligado sem CRM=desligado: erro em produção; com CRM=desligado, só aviso", () => {
        const semCrm = { ...ENV_PILOTO, CRM_URL: "", CRM_INTEGRATION_SECRET: "" };
        expect(verificarAmbiente(semCrm, FATOS_OK, { producao: true }).find((a) => a.item === "CRM")?.gravidade).toBe("erro");
        expect(verificarAmbiente({ ...semCrm, CRM_INTEGRATION_SECRET: "curto" , CRM_URL: "https://crm" }, FATOS_OK, { producao: true }).find((a) => a.item === "CRM")?.gravidade).toBe("erro");
        expect(verificarAmbiente({ ...semCrm, CRM: "desligado" }, FATOS_OK, { producao: true }).find((a) => a.item === "CRM")?.gravidade).toBe("aviso");
        expect(verificarAmbiente(semCrm, FATOS_OK, { producao: false }).find((a) => a.item === "CRM")?.gravidade).toBe("aviso");
      });

      it("exigirAmbiente: produção é o padrão e sai com 1; AMBIENTE=dev deixa passar; a ponte só olha o CRM", () => {
        const saida = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        const erro = vi.spyOn(console, "error").mockImplementation(() => {});
        const avisoConsole = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          exigirAmbiente("ponte", { CRM_URL: "" });
          expect(saida).toHaveBeenCalledWith(1);
          saida.mockClear();
          exigirAmbiente("ponte", { CRM_URL: "", AMBIENTE: "dev" });
          exigirAmbiente("ponte", { CRM: "desligado" });
          exigirAmbiente("ponte", { CRM_URL: "https://crm.loja.com.br", CRM_INTEGRATION_SECRET: "0123456789abcdef" });
          expect(saida).not.toHaveBeenCalled();
          exigirAmbiente("agente", { CRM: "desligado" });
          expect(saida).toHaveBeenCalledWith(1);
        } finally {
          saida.mockRestore();
          erro.mockRestore();
          avisoConsole.mockRestore();
        }
      });
    ```

- [ ] **Passo 2: rodar e ver falhar** → FAIL.

- [ ] **Passo 3: config** — em `src/config.ts`, troque as linhas 35-36 por:

```ts
    /** "mock" usa os JSONs de mocks/; "http" bate na API real. Sem padrão: em produção o agente não sobe sem dizer qual. */
    mode: (process.env.BRINDEME_MODE ?? "") as "mock" | "http",
```

- [ ] **Passo 4: regras** — em `src/operacao/verificacaoAmbiente.ts`:
  - Troque `const modo = env.BRINDEME_MODE ?? "mock";` e a linha seguinte (`if (modo === "mock") ...`) por:
    ```ts
      const modo = (env.BRINDEME_MODE ?? "").trim();
      if (!modo) naProducao("BRINDEME_MODE", "ausente: diga mock ou http no .env (sem padrão, para a produção nunca cair no mock sem avisar)");
      else if (modo === "mock") naProducao("BRINDEME_MODE", "mock: preços, estoque e pedidos são de mentira");
    ```
    (O `else if (modo !== "http")` seguinte continua.)
  - Depois do bloco "Conhecimento e catálogo":
    ```ts
      // CRM: desligado só de propósito
      const crmLigado = !!(env.CRM_URL ?? "").trim() && (env.CRM_INTEGRATION_SECRET ?? "").length >= 16;
      if (crmLigado) ok("CRM", (env.CRM_URL ?? "").trim());
      else if ((env.CRM ?? "").trim() === "desligado") aviso("CRM", "desligado de propósito (CRM=desligado): conversas e pedidos não chegam ao painel");
      else naProducao("CRM", "CRM_URL vazio ou CRM_INTEGRATION_SECRET com menos de 16 caracteres: sem painel e sem histórico do cliente. Se é de propósito, ponha CRM=desligado");
    ```

- [ ] **Passo 5: a trava** — `src/operacao/exigirAmbiente.ts`

```ts
/**
 * Trava de partida (spec da Fase 0, seção 8): processo que atende confere o ambiente e sai com 1 se houver ERRO.
 * Produção é o padrão; só AMBIENTE=dev no .env relaxa mock, rascunho, índice vazio e CRM desligado para aviso.
 */
import { existsSync } from "fs";
import { join } from "path";
import { arquivoIndicePadrao, FileProductIndexStore } from "../catalogo/indice.js";
import { lerEstadoSistema } from "../controle/estadoSistema.js";
import { carregarBase } from "../knowledge/base.js";
import { verificarAmbiente, type FatosAmbiente } from "./verificacaoAmbiente.js";

export function levantarFatos(env: Record<string, string | undefined> = process.env): FatosAmbiente {
  const modo = env.BRINDEME_MODE === "http" ? "http" : "mock";
  let produtos = 0;
  try {
    produtos = new FileProductIndexStore(arquivoIndicePadrao(modo)).carregar().produtos.length;
  } catch {
    produtos = 0;
  }
  const sistema = lerEstadoSistema();
  return {
    temArquivoEnv: existsSync(join(process.cwd(), ".env")),
    produtosNoIndice: produtos,
    itensAprovados: carregarBase({ incluirRascunhos: false }).base.estatisticas().servidos,
    suspenso: sistema.suspenso,
    ferramentasDesligadasRuntime: sistema.ferramentasDesligadas ?? [],
  };
}

export const ehProducao = (env: Record<string, string | undefined> = process.env): boolean => (env.AMBIENTE ?? "").trim() !== "dev";

/** "ponte": só o que a ponte usa (o CRM); "agente": tudo. */
export function exigirAmbiente(escopo: "agente" | "ponte", env: Record<string, string | undefined> = process.env): void {
  const producao = ehProducao(env);
  const achados = verificarAmbiente(env, levantarFatos(env), { producao }).filter((a) => escopo === "agente" || a.item === "CRM");
  for (const a of achados.filter((x) => x.gravidade === "aviso")) console.warn(`! ${a.item}: ${a.mensagem}`);
  const erros = achados.filter((a) => a.gravidade === "erro");
  if (erros.length === 0) return;
  for (const a of erros) console.error(`ERRO ${a.item}: ${a.mensagem}`);
  console.error(`Ambiente de ${producao ? "produção" : "desenvolvimento"} com erro: corrija o .env (ou ponha AMBIENTE=dev para desenvolver) e rode npm run verificar:env.`);
  process.exit(1);
}
```

- [ ] **Passo 6: script `verificar:env`** — em `scripts/verificarEnv.ts`, troque o bloco que vai de `const producao = ...` até o fim da chamada `verificarAmbiente(...)` por:

```ts
const producao = process.argv.includes("--producao") || ehProducao();
const achados = verificarAmbiente(process.env, levantarFatos(), { producao });
```
Troque os imports por `import { levantarFatos, ehProducao } from "../src/operacao/exigirAmbiente.js";` e `import { temErro, verificarAmbiente, type Gravidade } from "../src/operacao/verificacaoAmbiente.js";`, apagando os que ficaram sem uso (`existsSync`, `join`, `arquivoIndicePadrao`, `FileProductIndexStore`, `lerEstadoSistema`, `carregarBase`). No comentário do topo, troque as duas linhas de uso por:
```
 *   npm run verificar:env                # produção, a menos que o .env tenha AMBIENTE=dev
 *   npm run verificar:env -- --producao  # força as regras de produção mesmo com AMBIENTE=dev
```

- [ ] **Passo 7: pontos de partida**
  - `src/api/index.ts`: import `import { exigirAmbiente } from "../operacao/exigirAmbiente.js";` e, como primeira linha de `main()`: `  exigirAmbiente("agente");`.
  - `src/duble/index.ts`: o mesmo import e, como primeira linha do ramo `} else if (modo === "direto") {`: `    exigirAmbiente("agente");`.
  - `src/whatsapp/index.ts`: o mesmo import (`../operacao/exigirAmbiente.js`) e, como primeira linha de `main()`: `  exigirAmbiente("ponte");`.
  - (`src/lancador.ts`, citado na spec, é biblioteca, não ponto de partida: os processos que ele sobe já se conferem.)

- [ ] **Passo 8: `.env.example`** — depois da linha `BRINDEME_MODE=mock`:

```
# Produção é o padrão: mock, CRM desligado e índice vazio impedem a partida. Para desenvolver:
# AMBIENTE=dev
# Rodar sem o CRM de propósito:
# CRM=desligado
```

- [ ] **Passo 9: rodar tudo** — `npm run typecheck` e `npx vitest run --maxWorkers=1 --minWorkers=1` → verde.

- [ ] **Passo 10: commit**

```bash
git add -A src scripts tests .env.example
git commit -m "feat(operacao): produção não sobe em mock nem com o CRM desligado sem avisar"
```

> **Aviso para o João, que vai no relatório:** depois desta tarefa, o `.env` de desenvolvimento precisa de `AMBIENTE=dev`, ou `npm run agente` sai com erro. Na máquina do chip, o `.env` precisa de `CRM_URL` e de `CRM_INTEGRATION_SECRET` (16+ caracteres), ou de `CRM=desligado`.

---

### Tarefa 15: `sync:precos` e migração v1 → v2

**Arquivos:**
- Criar: `src/catalogo/syncPrecos.ts` e `scripts/syncPrecos.ts`
- Modificar: `package.json` (scripts) e `README.md` (seção de comandos, perto da linha 214)
- Teste: `tests/syncPrecos.test.ts`

**Interfaces:**
- Consome: `ConsultaPreco` (Tarefa 4); `montarFaixasDeVenda`, `pontosDeConsulta`, `chaveDoGrupo`, `hashDoGrupo` e `limitesDe` (Tarefa 2); `VERSAO_INDICE`, `IndiceCatalogo`, `ProductIndexStore`, `ProdutoIndexado` e `SubprodutoIndexado` (Tarefa 5).
- Produz: `FRACAO_MAXIMA_DE_FALHAS = 0.05`, `recalcularPrecos(indice, consultar, opcoes?)`, `sincronizarPrecos(store, consultar, opcoes?): Promise<ResultadoSyncPrecos>` e `esqueletoV2(v1): IndiceCatalogo`.

- [ ] **Passo 1: escrever o teste que falha** — `tests/syncPrecos.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { esqueletoV2, recalcularPrecos, sincronizarPrecos } from "../src/catalogo/syncPrecos.js";
import { construirRegistro, FileProductIndexStore, MemoryProductIndexStore, VERSAO_INDICE, type IndiceCatalogo, type ProductIndexStore } from "../src/catalogo/indice.js";
import { ErroPrecoVenda } from "../src/integrations/brindeme/precoVenda.js";
import { produto, sub } from "./helpers/produtos.js";

const T0 = new Date("2026-11-06T03:00:00Z");

/** n produtos, uma cor cada, grupo próprio, tabela antiga a R$ 10 entre 10 e 99. */
function indice(n: number): IndiceCatalogo {
  const produtos = Array.from({ length: n }, (_, i) =>
    construirRegistro(produto({ id: `p${i}`, nome: `P${i}`, min: 10, subprodutos: [{ ...sub(`s${i}`, "Azul", 100, [[10, 99, 10]]), grupo_preco: `g${i}` }] }), T0)
  );
  return { versao: VERSAO_INDICE, sincronizado_em: T0.toISOString(), completo: true, produtos };
}

const vitrine = (falhar = new Set<string>()) => {
  const chamadas: string[] = [];
  const consultar = async (id: string, qs: number[]) => {
    chamadas.push(id);
    if (falhar.has(id)) throw new ErroPrecoVenda("rede", "fora");
    return new Map(qs.map((q) => [q, q >= 10 && q <= 99 ? 2500 : 0]));
  };
  return { chamadas, consultar };
};

describe("sync de preços", () => {
  it("uma consulta por grupo; as faixas passam a ser as do site", async () => {
    const store = new MemoryProductIndexStore(indice(3));
    const { chamadas, consultar } = vitrine();
    const r = await sincronizarPrecos(store, consultar, { agora: T0 });
    expect(r).toMatchObject({ grupos: 3, atualizados: 3, falhas: [], gravou: true });
    expect(chamadas.sort()).toEqual(["s0", "s1", "s2"]);
    expect(store.carregar().produtos[0].subprodutos[0].faixas).toEqual([{ min: 10, max: 99, preco: 25 }]);
  });

  it("até 5% de falha: grava, e o grupo que falhou mantém as faixas anteriores", async () => {
    const store = new MemoryProductIndexStore(indice(20));
    const r = await sincronizarPrecos(store, vitrine(new Set(["s7"])).consultar, { agora: T0 });
    expect(r.gravou).toBe(true);
    expect(r.falhas).toEqual([{ produto_id: "p7", grupo_preco: "g7", erro: "fora" }]);
    const ps = store.carregar().produtos;
    expect(ps[7].subprodutos[0].faixas).toEqual([{ min: 10, max: 99, preco: 10 }]);
    expect(ps[8].subprodutos[0].faixas).toEqual([{ min: 10, max: 99, preco: 25 }]);
  });

  it("acima de 5% de falha: não grava nada", async () => {
    const antes = indice(20);
    const store = new MemoryProductIndexStore(antes);
    const r = await sincronizarPrecos(store, vitrine(new Set(["s1", "s2"])).consultar, { agora: T0 });
    expect(r.gravou).toBe(false);
    expect(store.carregar()).toBe(antes);
  });

  it("produto que entrou no índice durante o sync não some na gravação", async () => {
    let atual = indice(2);
    const store: ProductIndexStore = { carregar: () => atual, salvar: (i) => void (atual = i) };
    const { consultar } = vitrine();
    const lento = async (id: string, qs: number[]) => {
      // O sync:catalogo do agente grava um produto novo enquanto o sync de preços roda.
      if (!atual.produtos.some((p) => p.id === "p2")) atual = { ...atual, produtos: [...atual.produtos, ...indice(3).produtos.slice(2)] };
      return consultar(id, qs);
    };
    await sincronizarPrecos(store, lento, { agora: T0 });
    expect(atual.produtos.map((p) => p.id)).toEqual(["p0", "p1", "p2"]);
  });

  it("gravação atômica: no arquivo, sem sobrar .tmp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-precos-"));
    const store = new FileProductIndexStore(join(dir, "produtos-index.json"));
    store.salvar(indice(2));
    await sincronizarPrecos(store, vitrine().consultar, { agora: T0 });
    expect(readdirSync(dir)).toEqual(["produtos-index.json"]);
    expect(new FileProductIndexStore(join(dir, "produtos-index.json")).carregar().produtos[0].subprodutos[0].faixas[0].preco).toBe(25);
  });

  it("migração: o v1 (custo) vira v2 com limites e grupo, e nenhum valor de custo sobra", async () => {
    const v1 = {
      versao: 1,
      sincronizado_em: T0.toISOString(),
      completo: true,
      produtos: [{ ...indice(1).produtos[0], subprodutos: [
        { id: "s0", sku: "x", cor: "Azul", estoque: 100, faixas: [{ min: 10, max: 99, preco: 17.77 }] },
        { id: "s1", sku: "y", cor: "Roxa", estoque: 100, faixas: [{ min: 10, max: 99, preco: 17.77 }] },
      ] }],
    };
    const esqueleto = esqueletoV2(v1);
    expect(esqueleto.versao).toBe(VERSAO_INDICE);
    const [a, b] = esqueleto.produtos[0].subprodutos;
    expect(a).toMatchObject({ faixas: [], limites: [{ min: 10, max: 99 }] });
    expect(a.grupo_preco).toBe(b.grupo_preco);
    const { chamadas, consultar } = vitrine();
    const r = await recalcularPrecos(esqueleto, consultar, { agora: T0 });
    expect(chamadas).toEqual(["s0"]);
    expect(JSON.stringify(r.indice)).not.toContain("17.77");
    expect(r.indice.produtos[0].subprodutos[1].faixas).toEqual([{ min: 10, max: 99, preco: 25 }]);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar** → FAIL, módulo não encontrado.

- [ ] **Passo 3: implementar** — `src/catalogo/syncPrecos.ts`

```ts
/**
 * Sync de preços de venda (spec da Fase 0, 5.7): reconsulta o site para cada grupo de cores do índice, nos pontos
 * dos limites guardados. Não chama a API oficial. Mais de 5% de grupos com falha: não grava nada.
 */
import type { ConsultaPreco } from "../integrations/brindeme/clienteComPrecoDeVenda.js";
import { chaveDoGrupo, hashDoGrupo, limitesDe, montarFaixasDeVenda, pontosDeConsulta } from "./faixasDeVenda.js";
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
    produtos: v1.produtos.map((p) => ({
      ...p,
      subprodutos: p.subprodutos.map((s) => {
        const custo = s.faixas.map((f) => ({ min: f.min, max: f.max, price: f.preco }));
        return { id: s.id, sku: s.sku, cor: s.cor, estoque: s.estoque, faixas: [], limites: limitesDe(custo), grupo_preco: hashDoGrupo(chaveDoGrupo(custo)), faixas_venda_em: "" };
      }),
    })),
  };
}
```

- [ ] **Passo 4: script** — `scripts/syncPrecos.ts`

```ts
/**
 * Preço de venda do site no índice (Fase 0).
 *
 *   npm run sync:precos                    # noturno: reconsulta o site para cada grupo de cores
 *   npm run sync:precos -- --migrar        # uma vez: índice v1 (custo) → v2 (venda), sem guardar custo
 *   npm run sync:precos -- --concorrencia 3
 *
 * Só fala com a rota da vitrine, não com a API oficial. Mais de 5% dos grupos com falha: não grava nada e sai com 1.
 * Grupo que falhou na migração fica sem faixas (fora da busca) até o próximo sync:precos.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "fs";
import { config } from "../src/config.js";
import { arquivoIndicePadrao, FileProductIndexStore } from "../src/catalogo/indice.js";
import { esqueletoV2, FRACAO_MAXIMA_DE_FALHAS, recalcularPrecos, sincronizarPrecos, type ResultadoSyncPrecos } from "../src/catalogo/syncPrecos.js";
import { PrecoVendaHttp } from "../src/integrations/brindeme/precoVenda.js";

function numero(nome: string, padrao: number): number {
  const i = process.argv.indexOf(`--${nome}`);
  if (i === -1) return padrao;
  const n = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

async function main(): Promise<void> {
  if (config.brindeMe.mode !== "http") {
    console.error("sync:precos só roda com BRINDEME_MODE=http: no mock, a tabela dos fixtures já é o preço de venda.");
    process.exit(1);
  }
  const vitrine = new PrecoVendaHttp();
  const consultar = (id: string, qs: number[]) => vitrine.consultar(id, qs);
  const concorrencia = numero("concorrencia", 3);
  const arquivo = arquivoIndicePadrao("http");
  const store = new FileProductIndexStore(arquivo);
  const inicio = Date.now();
  const onProgresso = (feitos: number, total: number) => {
    if (feitos % 200 === 0 || feitos === total) console.log(`  ${feitos}/${total} grupos`);
  };

  let r: ResultadoSyncPrecos;
  if (process.argv.includes("--migrar")) {
    if (!existsSync(arquivo)) {
      console.error(`${arquivo} não existe: rode npm run sync:catalogo antes.`);
      process.exit(1);
    }
    const v1 = JSON.parse(readFileSync(arquivo, "utf-8"));
    if (v1.versao !== 1) {
      console.error(`O índice está na versão ${v1.versao}, não na 1: nada a migrar. Use npm run sync:precos.`);
      process.exit(1);
    }
    const novo = await recalcularPrecos(esqueletoV2(v1), consultar, { concorrencia, onProgresso });
    const gravou = novo.falhas.length / Math.max(1, novo.grupos) <= FRACAO_MAXIMA_DE_FALHAS;
    if (gravou) store.salvar(novo.indice);
    r = { grupos: novo.grupos, atualizados: novo.atualizados, falhas: novo.falhas, gravou };
  } else {
    r = await sincronizarPrecos(store, consultar, { concorrencia, onProgresso });
    if (r.grupos === 0) {
      console.error("Índice vazio ou ainda na versão 1: rode npm run sync:precos -- --migrar.");
      process.exit(1);
    }
  }

  console.log(`${r.atualizados}/${r.grupos} grupos atualizados em ${Math.round((Date.now() - inicio) / 1000)}s; ${r.falhas.length} falha(s).`);
  for (const f of r.falhas.slice(0, 20)) console.log(`  falhou: produto ${f.produto_id} grupo ${f.grupo_preco}: ${f.erro}`);
  if (!r.gravou) {
    console.error(`ALERTA: mais de ${FRACAO_MAXIMA_DE_FALHAS * 100}% dos grupos falharam; nada foi gravado.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Passo 5: `package.json`** — acrescente aos `scripts`, depois de `"sync:catalogo"`:

```json
"sync:precos": "tsx scripts/syncPrecos.ts",
"conferir:precos": "tsx scripts/conferirPrecos.ts",
"sondar:ritmo-precos": "tsx scripts/sondarRitmoPrecos.ts",
```
(Os dois últimos são criados na Tarefa 17.)

- [ ] **Passo 6: README** — no bloco de comandos perto da linha 214, depois das linhas do `sync:catalogo`:

```
npm run sync:precos                    # preço de venda do site → índice (job noturno, fora do agente)
npm run sync:precos -- --migrar        # uma vez, ao trocar o índice v1 (custo) pelo v2 (venda)
```

- [ ] **Passo 7: rodar** — `npx vitest run tests/syncPrecos.test.ts --maxWorkers=1 --minWorkers=1` → PASS; `npm run typecheck` → limpo.

- [ ] **Passo 8: commit**

```bash
git add src/catalogo/syncPrecos.ts scripts/syncPrecos.ts package.json README.md tests/syncPrecos.test.ts
git commit -m "feat(preco): sync:precos noturno e migração do índice v1 para v2"
```

---

### Tarefa 16: evals de preço e o A/B

**Arquivos:**
- Modificar: `evals/runEvals.ts`
- Criar: `evals/scenarios/33_sob_demanda.json` a `38_cotacao_vencida.json`

**Interfaces:**
- Consome: `setSobDemanda`; `MockBrindeMeClient.falharPrecoVenda`; `TurnResult.cartoes`; o `textoDoModelo` da Tarefa 12.

- [ ] **Passo 1: o runner** — em `evals/runEvals.ts`:
  - Import: `import { setSobDemanda } from "../src/catalogo/sobDemanda.js";`
  - Em `Expectativa.tipo`, acrescente `| "texto_nao_contem"`.
  - Em `Scenario`, acrescente:
    ```ts
      /** Ids de produto tratados como sob demanda neste cenário (a lista real tem ids que o mock não tem). */
      sob_demanda?: string[];
      /** A rota de preço da vitrine fora do ar. */
      falhar_preco_venda?: boolean;
      /** Só no modo direto: as cotações guardadas envelhecem 2 h antes da última mensagem. */
      envelhecer_cotacoes_antes_da_ultima?: boolean;
    ```
  - Em `runScenario`, logo depois do `if (scenario.injetar_falha) { ... }`:
    ```ts
      setSobDemanda(scenario.sob_demanda ?? []);
      client.falharPrecoVenda = scenario.falhar_preco_venda ?? false;
    ```
  - Junto de `let lastResponse = "";`, declare `let lastTexto = "";`.
  - No `for`, logo no começo do corpo:
    ```ts
        if (scenario.envelhecer_cotacoes_antes_da_ultima && !agenteApi && i === scenario.mensagens.length - 1) {
          for (const c of Object.values(state.cotacoes ?? {})) c.em = new Date(Date.now() - 2 * 3_600_000).toISOString();
        }
    ```
  - Troque `if (result.response) lastResponse = result.response;` por:
    ```ts
        // O que o cliente viu: cartões e texto. Pela API, a resposta já vem junta.
        const visto = agenteApi ? result.response : [...(result.cartoes ?? []).map((c) => c.legenda), result.response].filter(Boolean).join("\n\n");
        const textoDoModelo = agenteApi ? ((result as TurnResult & { textoDoModelo?: string | null }).textoDoModelo ?? null) : result.response;
        if (visto) lastResponse = visto;
        if (textoDoModelo) lastTexto = textoDoModelo;
    ```
  - No `switch`, depois de `resposta_nao_contem`:
    ```ts
          case "texto_nao_contem":
            results.push({
              passed: !new RegExp(exp.padrao!, "i").test(lastTexto),
              msg: `texto_nao_contem (só o texto do modelo): /${exp.padrao}/`,
            });
            break;
    ```

- [ ] **Passo 2: cenários** — crie os seis arquivos:

`evals/scenarios/33_sob_demanda.json`
```json
{
  "id": "33_sob_demanda",
  "descricao": "Produto sob demanda com estoque 0: aparece com preço e o agente não diz que falta estoque",
  "sob_demanda": ["prod-008"],
  "mensagens": ["Quero 30 camisetas personalizadas"],
  "expectativas": [
    { "tipo": "chamou_ferramenta", "ferramenta": "buscar_produtos" },
    { "tipo": "resposta_contem", "padrao": "Camiseta" },
    { "tipo": "resposta_contem", "padrao": "R\\$ ?\\d" },
    { "tipo": "resposta_nao_contem", "padrao": "sem estoque|não tem (no )?estoque|não temos" },
    { "tipo": "max_transferencias", "max": 0 }
  ]
}
```

`evals/scenarios/34_sem_estoque_oferece_humano.json`
```json
{
  "id": "34_sem_estoque_oferece_humano",
  "descricao": "Nenhum resultado com estoque para a quantidade: diz que não tem no estoque e oferece uma pessoa da equipe",
  "mensagens": ["Quero 30 camisetas personalizadas"],
  "expectativas": [
    { "tipo": "chamou_ferramenta", "ferramenta": "buscar_produtos" },
    { "tipo": "resposta_contem", "padrao": "estoque" },
    { "tipo": "resposta_contem", "padrao": "equipe|atendente|pessoa|consultor" }
  ]
}
```

`evals/scenarios/35_proximo_degrau.json`
```json
{
  "id": "35_proximo_degrau",
  "descricao": "Cartão traz o próximo degrau mais barato; o texto do modelo não redigita preço",
  "mensagens": ["Quero 50 canecas personalizadas"],
  "expectativas": [
    { "tipo": "chamou_ferramenta", "ferramenta": "buscar_produtos" },
    { "tipo": "resposta_contem", "padrao": "A partir de 100 un\\." },
    { "tipo": "texto_nao_contem", "padrao": "R\\$ ?\\d" }
  ]
}
```

`evals/scenarios/36_sem_degrau_mais_barato.json`
```json
{
  "id": "36_sem_degrau_mais_barato",
  "descricao": "Sem degrau mais barato acima da quantidade: a frase da condição especial da equipe",
  "mensagens": ["Quero 1000 chaveiros de acrílico personalizados"],
  "expectativas": [
    { "tipo": "chamou_ferramenta", "ferramenta": "buscar_produtos" },
    { "tipo": "resposta_contem", "padrao": "condição especial" }
  ]
}
```

`evals/scenarios/37_preco_indisponivel.json`
```json
{
  "id": "37_preco_indisponivel",
  "descricao": "Rota de preço fora: produto sem preço, valor com a equipe, nenhum R$ inventado",
  "critico": true,
  "falhar_preco_venda": true,
  "mensagens": ["Quero 50 canecas personalizadas"],
  "expectativas": [
    { "tipo": "chamou_ferramenta", "ferramenta": "buscar_produtos" },
    { "tipo": "resposta_contem", "padrao": "confirmar|equipe" },
    { "tipo": "resposta_nao_contem", "padrao": "R\\$ ?\\d" }
  ]
}
```

`evals/scenarios/38_cotacao_vencida.json`
```json
{
  "id": "38_cotacao_vencida",
  "descricao": "Orçamento depois de 2 h do detalhe: cota de novo e mostra a estimativa, sem transferir",
  "envelhecer_cotacoes_antes_da_ultima": true,
  "mensagens": [
    "me fala da caneca de porcelana, quero 50 unidades",
    "quero as 50 na cor branca. PF, João Silva, joao@teste.com"
  ],
  "expectativas": [
    { "tipo": "chamou_ferramenta", "ferramenta": "preparar_orcamento" },
    { "tipo": "resposta_contem", "padrao": "R\\$ ?\\d" },
    { "tipo": "max_transferencias", "max": 0 }
  ]
}
```

- [ ] **Passo 3: typecheck e testes** — `npm run typecheck`; `npx vitest run tests/ambienteEvals.test.ts tests/schemasECenarios.test.ts --maxWorkers=1 --minWorkers=1` → verde. (`schemasECenarios` valida os JSONs dos cenários: se ele recusar os campos novos, acrescente-os ao schema que ele usa, com os mesmos tipos de `Scenario`.)

- [ ] **Passo 4: o B do A/B**

```bash
npm run evals -- --rodadas 3 --relatorio "../Validações/evals-fase0-depois.json"
```
Esperado: nos cenários 01–32, cada um passa em pelo menos tantas rodadas quanto na Tarefa 0. **Regra de parada:** se algum dos antigos cair, **não mexa no prompt por tentativa e erro**. Anote o cenário, as rodadas antes e depois e a resposta que falhou, e devolva ao João. Mudança de prompt pede A/B do cenário afetado (lição de 25/10). Os cenários 33–38 são novos e não têm piso; anote o resultado deles.

- [ ] **Passo 5: commit**

```bash
git add evals
git commit -m "test(evals): cenários de preço de venda, sob demanda e cartões"
```

---

### Tarefa 17: ferramentas de validação com dado real (o João roda)

**Arquivos:**
- Criar: `src/operacao/conferenciaPrecos.ts`, `scripts/conferirPrecos.ts` e `scripts/sondarRitmoPrecos.ts`
- Teste: `tests/conferenciaPrecos.test.ts`

**Interfaces:**
- Produz: `sorteador(semente: number): () => number`, `sortear<T>(lista: T[], n: number, aleatorio: () => number, sempre?: (x: T) => boolean): T[]` e `quantidadesDeTeste(limites: Limite[], minimo: number, aleatorio: () => number, quantas?: number): number[]`.

- [ ] **Passo 1: escrever o teste que falha** — `tests/conferenciaPrecos.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { quantidadesDeTeste, sortear, sorteador } from "../src/operacao/conferenciaPrecos.js";

describe("conferência de preços: sorteio reproduzível", () => {
  it("mesma semente, mesma sequência", () => {
    const a = sorteador(20261105);
    const b = sorteador(20261105);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("sortear devolve n itens sem repetir e sempre inclui os obrigatórios", () => {
    const lista = Array.from({ length: 50 }, (_, i) => `p${i}`);
    const r = sortear(lista, 10, sorteador(1), (x) => x === "p42" || x === "p7");
    expect(r).toHaveLength(10);
    expect(new Set(r).size).toBe(10);
    expect(r).toEqual(expect.arrayContaining(["p42", "p7"]));
  });

  it("quantidades: o mínimo sempre, e só pontos ≥ mínimo e ≤ 5000 tirados dos limites e dos degraus", () => {
    const qs = quantidadesDeTeste([{ min: 10, max: 18 }, { min: 51, max: 100 }], 10, sorteador(3), 4);
    expect(qs[0]).toBe(10);
    expect(qs).toHaveLength(4);
    expect(qs.every((q) => q >= 10 && q <= 5000)).toBe(true);
    expect(new Set(qs).size).toBe(4);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar** → FAIL.

- [ ] **Passo 3: implementar** — `src/operacao/conferenciaPrecos.ts`

```ts
/** Sorteio reproduzível da conferência de preços (spec da Fase 0, 9.3). */
import { DEGRAUS_DO_SITE, type Limite } from "../catalogo/faixasDeVenda.js";

/** mulberry32: a mesma semente dá a mesma amostra, para repetir a conferência. */
export function sorteador(semente: number): () => number {
  let s = semente >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sortear<T>(lista: T[], n: number, aleatorio: () => number, sempre: (x: T) => boolean = () => false): T[] {
  const fixos = lista.filter(sempre);
  const resto = lista.filter((x) => !sempre(x));
  for (let i = resto.length - 1; i > 0; i--) {
    const j = Math.floor(aleatorio() * (i + 1));
    [resto[i], resto[j]] = [resto[j], resto[i]];
  }
  return [...fixos, ...resto].slice(0, Math.max(n, fixos.length));
}

export function quantidadesDeTeste(limites: Limite[], minimo: number, aleatorio: () => number, quantas = 3): number[] {
  const candidatas = [...new Set([...limites.flatMap((l) => [l.min, l.max]), ...DEGRAUS_DO_SITE])].filter(
    (q) => q > minimo && q <= 5000
  );
  return [minimo, ...sortear(candidatas, quantas - 1, aleatorio)];
}
```

- [ ] **Passo 4: rodar** — `npx vitest run tests/conferenciaPrecos.test.ts --maxWorkers=1 --minWorkers=1` → PASS.

- [ ] **Passo 5: `scripts/conferirPrecos.ts`**

```ts
/**
 * Critério de aceite da Fase 0 (spec 9.3): o preço que as ferramentas dão é o da vitrine, com tolerância zero.
 * Também confere, na mesma amostra, que nenhum preço guardado no índice é igual ao custo da API ao vivo.
 *
 *   npm run conferir:precos                       # 100 produtos, semente 20261105
 *   npm run conferir:precos -- --produtos 20 --semente 7
 *
 * Precisa de BRINDEME_MODE=http e do índice v2. Faz ~5 leituras da API oficial por produto: rode com o agente desligado.
 * Não grava nada: preparar_orcamento só estima (R5).
 */
import "dotenv/config";
import { config } from "../src/config.js";
import { FileProductIndexStore } from "../src/catalogo/indice.js";
import { createBrindeMeClient } from "../src/integrations/brindeme/factory.js";
import { HttpBrindeMeClient } from "../src/integrations/brindeme/httpClient.js";
import { PrecoVendaHttp } from "../src/integrations/brindeme/precoVenda.js";
import { detalharProdutoHandler } from "../src/tools/detalharProduto.js";
import { prepararOrcamentoHandler } from "../src/tools/prepararOrcamento.js";
import { createInitialState } from "../src/agent/state.js";
import { quantidadesDeTeste, sortear, sorteador } from "../src/operacao/conferenciaPrecos.js";

const SEMPRE = new Set(["afc89ae2-d187-405a-b826-d2e2ae0447f5", "dd4c5dbf-ab7d-4084-8c2b-e2f7e28669de"]);
const TELEFONE_FICTICIO = "5500000000000";

function numero(nome: string, padrao: number): number {
  const i = process.argv.indexOf(`--${nome}`);
  const n = i === -1 ? NaN : Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

async function main(): Promise<void> {
  if (config.brindeMe.mode !== "http") {
    console.error("conferir:precos precisa de BRINDEME_MODE=http.");
    process.exit(1);
  }
  const aleatorio = sorteador(numero("semente", 20261105));
  const indice = new FileProductIndexStore().carregar();
  if (indice.produtos.length === 0) {
    console.error("Índice vazio ou v1: rode npm run sync:precos -- --migrar.");
    process.exit(1);
  }
  const client = createBrindeMeClient({ reqPorMinuto: config.catalogo.reqPorMinuto });
  const custoCru = new HttpBrindeMeClient({ reqPorMinuto: config.catalogo.reqPorMinuto });
  const vitrine = new PrecoVendaHttp();

  const amostra = sortear(indice.produtos, numero("produtos", 100), aleatorio, (p) => SEMPRE.has(p.id));
  let conferidos = 0;
  const divergencias: string[] = [];
  const iguaisAoCusto: string[] = [];

  for (const p of amostra) {
    const sub = p.subprodutos[Math.floor(aleatorio() * p.subprodutos.length)];
    if (!sub) continue;
    const quantidades = quantidadesDeTeste(sub.limites ?? [], p.quantidade_minima, aleatorio);
    for (const [i, q] of quantidades.entries()) {
      const site = (await vitrine.consultar(sub.id, [q])).get(q) ?? 0;
      const det = (await detalharProdutoHandler({ produto_id: p.id, quantidade: q }, createInitialState(TELEFONE_FICTICIO), client)) as {
        subprodutos_ativos?: Array<{ subproduto_id: string; preco_para_quantidade: number | null; atende_quantidade: boolean | null }>;
      };
      const cor = det.subprodutos_ativos?.find((s) => s.subproduto_id === sub.id);
      if (cor && cor.atende_quantidade) {
        conferidos++;
        const agente = cor.preco_para_quantidade === null ? 0 : Math.round(cor.preco_para_quantidade * 100);
        if (agente !== site) divergencias.push(`detalhar ${p.nome} (${sub.cor}) ${q} un.: agente ${agente} × site ${site}`);
      }
      if (i === 0) {
        const state = createInitialState(TELEFONE_FICTICIO);
        state.subprodutoParaProduto[sub.id] = p.id;
        const orc = (await prepararOrcamentoHandler(
          { tipo: "PF", nome: "Conferência de preços", email: "conferencia@example.com", itens: [{ subproduto_id: sub.id, quantidade: q }] },
          state,
          client
        )) as { resumo?: { itens: Array<{ preco_unitario: number }> }; erro?: string };
        if (orc.resumo || orc.erro === "preco_indisponivel") {
          conferidos++;
          const agente = orc.resumo ? Math.round(orc.resumo.itens[0].preco_unitario * 100) : 0;
          if (agente !== site) divergencias.push(`orcamento ${p.nome} (${sub.cor}) ${q} un.: agente ${agente} × site ${site}`);
        }
      }
    }
    const cru = await custoCru.getProduct(p.id).catch(() => null);
    const custo = cru?.subproducts.find((s) => s.id === sub.id)?.prices ?? [];
    for (const f of sub.faixas) {
      const c = custo.find((x) => f.min >= x.min && f.min <= x.max);
      if (c && Math.round(c.price * 100) === Math.round(f.preco * 100)) iguaisAoCusto.push(`${p.nome} (${sub.cor}) a partir de ${f.min}: ${f.preco}`);
    }
  }

  console.log(`\n${conferidos} preço(s) conferido(s) em ${amostra.length} produto(s).`);
  console.log(`Divergências do site: ${divergencias.length}`);
  for (const d of divergencias) console.log(`  ${d}`);
  console.log(`Preços do índice iguais ao custo: ${iguaisAoCusto.length}`);
  for (const d of iguaisAoCusto) console.log(`  ${d}`);
  if (divergencias.length || iguaisAoCusto.length) process.exit(1);
  console.log("100% igual ao site e nenhum custo no índice.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Passo 6: `scripts/sondarRitmoPrecos.ts`**

```ts
/**
 * Sonda de ritmo da rota de preço da vitrine (spec 9.3): a brinde.me não diz o limite de chamadas.
 * Sobe o ritmo em degraus de 30 s (1, 2, 4, 8 e 16 chamadas por segundo) e PARA no primeiro 429 ou erro.
 *
 *   npm run sondar:ritmo-precos
 *
 * Rode fora do horário de pico, com o agente desligado. Leva no máximo 2,5 min.
 */
import "dotenv/config";
import { FileProductIndexStore } from "../src/catalogo/indice.js";
import { DOMINIO_LOJA, ROTA_VITRINE } from "../src/integrations/brindeme/precoVenda.js";

const DRAY_FIT = "afc89ae2-d187-405a-b826-d2e2ae0447f5";
const RITMOS = [1, 2, 4, 8, 16];
const DEGRAU_MS = 30_000;

async function chamar(subprodutoId: string): Promise<{ status: number | "erro"; ms: number }> {
  const inicio = Date.now();
  try {
    const r = await fetch(`${ROTA_VITRINE}/api/subproduct/${subprodutoId}/price/10?domain=${DOMINIO_LOJA}`, {
      headers: { Accept: "application/json", domain: DOMINIO_LOJA },
      signal: AbortSignal.timeout(5_000),
    });
    await r.text();
    return { status: r.status, ms: Date.now() - inicio };
  } catch {
    return { status: "erro", ms: Date.now() - inicio };
  }
}

async function main(): Promise<void> {
  const dray = new FileProductIndexStore().carregar().produtos.find((p) => p.id === DRAY_FIT);
  const sub = dray?.subprodutos[0]?.id;
  if (!sub) {
    console.error("Camisa Dray Fit não está no índice (rode sync:catalogo / sync:precos --migrar).");
    process.exit(1);
  }
  let ultimoBom = 0;
  for (const porSegundo of RITMOS) {
    const pendentes: Array<Promise<{ status: number | "erro"; ms: number }>> = [];
    const fim = Date.now() + DEGRAU_MS;
    while (Date.now() < fim) {
      pendentes.push(chamar(sub));
      await new Promise((r) => setTimeout(r, 1000 / porSegundo));
    }
    const r = await Promise.all(pendentes);
    const ok = r.filter((x) => x.status === 200).length;
    const ms = r.map((x) => x.ms).sort((a, b) => a - b);
    const ruins = r.filter((x) => x.status !== 200);
    console.log(`${porSegundo}/s: ${r.length} chamadas, ${ok} ok, ${ruins.length} com 429/erro, mediana ${ms[Math.floor(ms.length / 2)]} ms`);
    if (ruins.length) {
      console.log(`Parou em ${porSegundo}/s (${[...new Set(ruins.map((x) => x.status))].join(", ")}).`);
      break;
    }
    ultimoBom = porSegundo;
  }
  console.log(`Último ritmo sem erro: ${ultimoBom}/s. Leve este número ao relatório: ele define a concorrência do sync:precos.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Passo 7: typecheck e commit**

```bash
npm run typecheck
git add src/operacao/conferenciaPrecos.ts scripts/conferirPrecos.ts scripts/sondarRitmoPrecos.ts tests/conferenciaPrecos.test.ts
git commit -m "feat(validacao): conferir:precos e sonda de ritmo da rota da vitrine"
```

- [ ] **Passo 8 (o João, com o `.env` real e o agente desligado), nesta ordem:**
  1. `npm run sondar:ritmo-precos`: anote o último ritmo sem erro. **Regra de parada:** se parar já em 1/s, não siga para a migração. A concorrência 3 do sync estouraria o limite: leve o número ao Claude para rever o `--concorrencia`.
  2. Faça backup do índice: `cp data/produtos-index.json data/produtos-index-v1.json`.
  3. `npm run sync:precos -- --migrar --concorrencia <valor que a sonda permitir, até 3>`: anote o tempo e as falhas para o relatório.
  4. `npm run conferir:precos`: tem de terminar com "100% igual ao site e nenhum custo no índice." Qualquer divergência é bloqueio: não ligue o agente. Leve a saída ao Claude.

---

### Tarefa 18: fechamento

- [ ] **Passo 1: tudo verde**

```bash
npm run typecheck
npx vitest run --maxWorkers=1 --minWorkers=1
git status --short   # só o " M .gitignore" de antes pode sobrar
git log --oneline preco-de-venda-do-site -20
```

- [ ] **Passo 2: checklist de dogfooding (o João, no número extra, com a ponte real):**
  - [ ] Dray Fit com 10 un.: foto com legenda e preço de R$ 42,41/un, mais "A partir de 19 un.".
  - [ ] Dray Fit com 25 un.: sem preço ("Valor a confirmar com a equipe."); fechar transfere.
  - [ ] Dray Fit com 100 un.: R$ 37,84/un e a frase da condição especial.
  - [ ] Caneca Mágica com 50 un.: aparece com preço, mesmo com estoque 0 (sob demanda).
  - [ ] Um produto de fornecedor sem estoque para a quantidade: "não tem no estoque" e oferta de humano.
  - [ ] **Foto chegando como foto, e a conversa continua com a Lia** depois do envio, sem "atendente assumiu" no log da ponte (Foco da revisão 1).
  - [ ] Filtro de orçamento: com um teto por unidade, nenhum cartão acima do teto.
  - [ ] Rota derrubada à força: com a internet da máquina sem acesso a `app3.brinde.me` (regra de firewall, ou `127.0.0.1 app3.brinde.me` no `hosts`), a resposta sai sem preço e fechar transfere. **Desfaça a regra ao terminar.**
  - [ ] Nenhum preço diferente do site em toda a sessão (confira 10 produtos em `presentesespeciais.com.br/brinde/<slug>`, no Claude Desktop).

- [ ] **Passo 3: o relatório volta para o Claude.** Ele traz:
  - os números dos evals antes e depois, por cenário;
  - o ritmo da sonda;
  - o tempo e as falhas da migração;
  - a saída do `conferir:precos`;
  - o checklist marcado.

  Push e PR só quando o João mandar.

---

## Riscos que seguem abertos (não são deste plano)

- A rota `app3` pode mudar sem aviso. Mitigação: o disjuntor, o "produto sem preço" e a trava de 5% no sync.
- A biblioteca do WhatsApp já confirmou um envio (documento) que não chegou. O recuo para texto só pega o envio que **lança erro**, não o que "sai" e não chega.
- Até o primeiro `sync:precos` depois da migração, um grupo que falhou nela fica sem faixas e fora da busca.
- Se a foto falhar e a legenda sair como texto, o registro da foto que falhou pode fazer o CRM mostrar a URL junto desse texto. É cosmético.
