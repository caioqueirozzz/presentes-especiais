/**
 * Motor semântico da busca (spec §3.5).
 *
 * O que ele resolve: a busca lexical casa palavra solta, então "camisa dry fit"
 * trazia o Porta Latas Camisa e "caneca mágica" trazia a Escova Mágica. Aqui o
 * produto só é candidato se o TIPO dele bate com o tipo que o cliente nomeou.
 *
 * Dois cossenos, com papéis diferentes:
 *  - o do TIPO filtra (passa do piso ou está fora);
 *  - o do TEXTO ordena (continua alimentando a fórmula de relevância de hoje).
 *
 * O retrato (vetores + tipos) é carregado uma vez e fica em memória; as stores
 * só releem quando o arquivo muda, então a conversa não espera E/S por pergunta
 * — é o contrato combinado com a Fase 1 (spec §9). A única chamada de rede por
 * busca é o embedding da consulta, e consulta repetida sai do cache.
 */
import { cossenoNaLinha, type ConjuntoVetores, type VectorStore } from "./vetores.js";
import { mapaDeTipos, type TipoStore } from "./tipos.js";
import {
  CacheEmbeddings,
  embeddingDe,
  MODELO_EMBEDDING,
  type ClienteEmbeddings,
} from "../llm/embeddings.js";
import { logarBuscaDegradada } from "./logBusca.js";

/**
 * Filtro por tipo: um piso ABSOLUTO e uma margem RELATIVA ao melhor tipo.
 *
 * Calibrado na medição das 40 consultas (spec §8, `--comparar --varrer`). Os
 * cossenos medidos, que explicam os dois números:
 *
 *   "camiseta"                  × camiseta                   1,000
 *   "caneca"                    × caneca                     1,000
 *   "miniatura de empilhadeira" × miniatura de empilhadeira   1,000
 *   "miniatura de empilhadeira" × miniatura de carro          0,717   ← outro tipo
 *   "guarda-chuva" (não existe) × chaveiro                    0,379   ← ruído
 *   "ecobag"                    × caneca                      0,371   ← ruído
 *   "power bank"  (não existe)  × kit                         0,335   ← ruído
 *
 * O tipo certo dá ~1,000; abaixo de ~0,45 é ruído, e lá o tipo ERRADO chega a
 * pontuar mais que o certo. Por isso o piso ABSOLUTO fica em 0,60: acima da
 * faixa de ruído por uma folga larga, de modo que quem pede um tipo que a loja
 * não tem caia em `nenhum_do_tipo` em vez de receber qualquer coisa.
 *
 * Só o piso não basta: "miniatura de carro", a 0,717, passaria. É para isso que
 * existe a MARGEM. O melhor tipo da rodada vira a régua e só fica quem está a
 * menos de 0,20 dele — com a empilhadeira em 1,000, o corte sobe para 0,80 e o
 * carro cai. Subir o piso a 0,75 resolveria este caso e quebraria os pedidos
 * escritos de outro jeito que hoje pontuam entre 0,80 e 0,95.
 *
 * O caso da ecobag, que a medição também achou, NÃO se resolve aqui: ela estava
 * rotulada como "sacola" e nenhum limiar separa 0,353 (certo) de 0,379 (errado).
 * A correção foi no rotulador — usar a palavra do próprio nome do produto — e,
 * se escapar de novo, em `tipos-corrigidos.json`.
 */
export const PISO_TIPO_PADRAO = 0.6;
/** Distância máxima até o melhor tipo da rodada: 0,20 separa a empilhadeira (1,000) do carro (0,717). */
export const MARGEM_TIPO_PADRAO = 0.2;
/**
 * Sem `tipo_produto`, cosseno mínimo entre a consulta e o texto do produto. Sem ele
 * o catálogo inteiro vira candidato e a busca nunca responde "não encontrei".
 */
// shortcut: chute sem o catálogo real, calibrar com --comparar --piso-texto depois do sync completo
export const PISO_TEXTO_PADRAO = 0.3;

export interface RetratoSemantico {
  vetores: ConjuntoVetores;
  /** `null` quando os tipos ainda não foram vetorizados: sem ele não há filtro por tipo. */
  vetoresTipo: ConjuntoVetores | null;
  /** produto_id → tipo canônico, já com as correções da loja. */
  tipos: Map<string, string>;
}

export interface DependenciasSemantica {
  vetoresProduto: VectorStore;
  vetoresTipo: VectorStore;
  tipos: TipoStore;
  embeddings: ClienteEmbeddings;
  modelo?: string;
  piso?: number;
  margem?: number;
  pisoTexto?: number;
}

export class MotorSemantico {
  private readonly cache = new CacheEmbeddings();
  private avisouSemVetores = false;
  private avisouModelo = false;

  constructor(private readonly deps: DependenciasSemantica) {}

  get piso(): number {
    return this.deps.piso ?? PISO_TIPO_PADRAO;
  }

  get margem(): number {
    return this.deps.margem ?? MARGEM_TIPO_PADRAO;
  }

  get pisoTexto(): number {
    return this.deps.pisoTexto ?? PISO_TEXTO_PADRAO;
  }

  private get modelo(): string {
    return this.deps.modelo ?? MODELO_EMBEDDING;
  }

  /**
   * O retrato atual. `null` quando não há vetores gravados — aí a busca roda em
   * BM25 e avisa uma vez por carga, não uma vez por pergunta (o cliente não tem
   * culpa, mas o log não pode virar enxurrada).
   */
  async retrato(): Promise<RetratoSemantico | null> {
    const vetores = await this.deps.vetoresProduto.carregar();
    if (!vetores || vetores.ids.length === 0) {
      if (!this.avisouSemVetores) {
        this.avisouSemVetores = true;
        logarBuscaDegradada({ motivo: "sem_vetores", detalhe: "rode npm run gerar:vetores" });
      }
      return null;
    }
    this.avisouSemVetores = false;
    // Vetor de outro modelo mede outra coisa (ou outra dimensão): cosseno vira lixo.
    if (vetores.modelo !== this.modelo) {
      if (!this.avisouModelo) {
        this.avisouModelo = true;
        logarBuscaDegradada({ motivo: "modelo_divergente", detalhe: `${vetores.modelo} ≠ ${this.modelo}` });
      }
      return null;
    }
    this.avisouModelo = false;
    const vetoresTipo = await this.deps.vetoresTipo.carregar();
    return {
      vetores,
      vetoresTipo: vetoresTipo?.modelo === this.modelo ? vetoresTipo : null,
      tipos: mapaDeTipos(await this.deps.tipos.carregar()),
    };
  }

  /**
   * Embedding de um texto de consulta, com cache. `null` quando a OpenAI falha
   * — quem chama cai no BM25 em vez de devolver erro ao cliente.
   */
  async embedding(texto: string): Promise<Float32Array | null> {
    const limpo = texto.trim();
    if (!limpo) return null;
    const guardado = this.cache.obter(limpo);
    if (guardado) return guardado;
    try {
      const v = await embeddingDe(this.deps.embeddings, limpo, this.modelo);
      if (v) this.cache.guardar(limpo, v);
      return v;
    } catch (err) {
      logarBuscaDegradada({
        motivo: "embedding_falhou",
        detalhe: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

export interface PontuacaoSemantica {
  /** Cosseno entre a consulta e o texto do produto, 0..1 (negativos viram 0). */
  similaridade: number;
  /** Cosseno entre o tipo pedido e o tipo do produto; `null` sem filtro de tipo. */
  similaridadeTipo: number | null;
}

/**
 * Pontua o catálogo inteiro contra a consulta.
 *
 * `vetorTipo` só vem quando o cliente nomeou um tipo. Nesse caso o produto que
 * não passa do piso — e o produto SEM tipo — fica de fora: é esta linha que
 * impede o porta-latas de aparecer para quem pediu camisa.
 */
export function pontuarCatalogo(
  produtoIds: string[],
  retrato: RetratoSemantico,
  vetorConsulta: Float32Array,
  vetorTipo: Float32Array | null,
  piso: number,
  margem = MARGEM_TIPO_PADRAO,
  pisoTexto = 0
): Map<string, PontuacaoSemantica> {
  const { vetores, vetoresTipo, tipos } = retrato;
  const out = new Map<string, PontuacaoSemantica>();

  // Cosseno do tipo pedido contra cada TIPO distinto, não contra cada produto:
  // são poucas centenas de tipos para milhares de produtos.
  const notaDoTipo = new Map<string, number>();
  if (vetorTipo && vetoresTipo) {
    for (const [tipo, linha] of vetoresTipo.linhaDe) {
      notaDoTipo.set(tipo, cossenoNaLinha(vetorTipo, vetoresTipo.matriz, linha, vetoresTipo.dimensao));
    }
  }

  const filtrandoPorTipo = vetorTipo !== null && vetoresTipo !== null;

  // A régua é o melhor tipo desta rodada, entre os que o catálogo realmente usa:
  // um tipo vetorizado que nenhum produto carrega não pode definir o corte.
  let corte = piso;
  if (filtrandoPorTipo) {
    const emUso = new Set(tipos.values());
    let melhor = 0;
    for (const [tipo, nota] of notaDoTipo) {
      if (emUso.has(tipo) && nota > melhor) melhor = nota;
    }
    corte = Math.max(piso, melhor - margem);
  }

  for (const id of produtoIds) {
    const linha = vetores.linhaDe.get(id);
    if (linha === undefined) continue; // sem vetor: só pelo BM25, até a próxima geração

    let similaridadeTipo: number | null = null;
    if (filtrandoPorTipo) {
      const tipo = tipos.get(id);
      if (!tipo) continue; // sem tipo não dá para afirmar que é o que o cliente pediu
      const nota = notaDoTipo.get(tipo);
      if (nota === undefined || nota < corte) continue;
      similaridadeTipo = nota;
    }

    const bruto = cossenoNaLinha(vetorConsulta, vetores.matriz, linha, vetores.dimensao);
    // Sem tipo, o piso de texto é o único filtro: sem ele todo o catálogo entraria.
    if (!filtrandoPorTipo && bruto < pisoTexto) continue;
    out.set(id, { similaridade: Math.max(0, bruto), similaridadeTipo });
  }

  return out;
}

/**
 * Produto que a semântica não consegue pontuar e por isso vai ao BM25 (spec §3.6):
 * sem vetor, ou, filtrando por tipo, com um tipo que ainda não foi vetorizado
 * (correção da loja feita depois da última geração).
 */
export function semNotaSemantica(id: string, retrato: RetratoSemantico, filtrandoPorTipo: boolean): boolean {
  if (!retrato.vetores.linhaDe.has(id)) return true;
  if (!filtrandoPorTipo || !retrato.vetoresTipo) return false;
  const tipo = retrato.tipos.get(id);
  return !!tipo && !retrato.vetoresTipo.linhaDe.has(tipo);
}
