/**
 * Geração dos tipos e dos vetores do catálogo (spec §3.3).
 *
 * Roda pelo `npm run gerar:vetores` e no fim de um `sync:catalogo` bem
 * sucedido. Só mexe no que mudou: produto cujo `atualizado_em` é igual ao
 * gravado mantém o rótulo e o vetor que já tinha.
 *
 * A TRAVA é a parte que importa: com mais de 5% dos produtos sem rótulo ou sem
 * vetor, nada é gravado e o processo sai com código 1. Meio catálogo rotulado é
 * pior do que catálogo nenhum, porque o filtro por tipo descartaria em silêncio
 * justamente os produtos que ficaram de fora.
 */
import type { ProdutoIndexado } from "./indice.js";
import {
  mapaDeTipos,
  tabelaTiposVazia,
  type TabelaTipos,
  type TipoStore,
} from "./tipos.js";
import { montarConjunto, type ConjuntoVetores, type VectorStore } from "./vetores.js";
import {
  embeddingsDe,
  textoDoProduto,
  DIMENSAO_EMBEDDING,
  LOTE_EMBEDDING,
  MODELO_EMBEDDING,
  type ClienteEmbeddings,
} from "../llm/embeddings.js";
import { rotularEmLote, type ClienteRotulo } from "../llm/rotulador.js";

/** Fração de produtos sem rótulo ou sem vetor que ainda permite gravar. */
export const MAX_FALHAS = 0.05;

export interface DependenciasGeracao {
  tipos: TipoStore;
  vetoresProduto: VectorStore;
  vetoresTipo: VectorStore;
  embeddings: ClienteEmbeddings;
  rotulos: ClienteRotulo;
  agora?: () => Date;
}

export interface OpcoesGeracao {
  /** Rotula e vetoriza tudo, ignorando `atualizado_em`. */
  forcar?: boolean;
  concorrenciaRotulo?: number;
  modeloEmbedding?: string;
  modeloRotulo?: string;
  onProgresso?(evento: { fase: "rotulo" | "vetor-produto" | "vetor-tipo"; feitos: number; total: number }): void;
}

export interface ResultadoGeracao {
  produtos: number;
  rotulados: number;
  reaproveitadosRotulo: number;
  vetorizados: number;
  reaproveitadosVetor: number;
  tiposDistintos: number;
  /** Produtos sem rótulo ou sem vetor ao fim da rodada. */
  falhas: Array<{ id: string; nome: string; erro: string }>;
  /** A trava disparou: nada foi gravado. */
  travou: boolean;
  gravou: boolean;
}

/** Texto que identifica a versão do produto; mudou, regera. */
function origemDoProduto(p: ProdutoIndexado): string {
  return p.atualizado_em || p.sincronizado_em || "";
}

export async function gerarTiposEVetores(
  produtos: ProdutoIndexado[],
  deps: DependenciasGeracao,
  opcoes: OpcoesGeracao = {}
): Promise<ResultadoGeracao> {
  const agora = deps.agora ?? (() => new Date());
  const modeloEmbedding = opcoes.modeloEmbedding ?? MODELO_EMBEDDING;

  const tabelaAnterior = await deps.tipos.carregar();
  const vetoresAnteriores = await deps.vetoresProduto.carregar();

  // --- 1. Rótulos de tipo -------------------------------------------------------
  const precisamRotulo = produtos.filter((p) => {
    if (opcoes.forcar) return true;
    const anterior = tabelaAnterior.produtos[p.id];
    return !anterior || !anterior.tipo || anterior.atualizado_em !== origemDoProduto(p);
  });

  const rotulagem = await rotularEmLote(
    deps.rotulos,
    precisamRotulo.map((p) => ({ id: p.id, nome: p.nome, categorias: p.categorias, descricao: p.descricao })),
    [...new Set(Object.values(tabelaAnterior.produtos).map((t) => t.tipo).filter(Boolean))],
    {
      concorrencia: opcoes.concorrenciaRotulo,
      modelo: opcoes.modeloRotulo,
      onProgresso: (feitos, total) => opcoes.onProgresso?.({ fase: "rotulo", feitos, total }),
    }
  );

  const tabela: TabelaTipos = tabelaTiposVazia();
  for (const p of produtos) {
    const novo = rotulagem.tipos.get(p.id);
    const anterior = tabelaAnterior.produtos[p.id];
    const tipo = novo ?? anterior?.tipo ?? "";
    if (tipo) tabela.produtos[p.id] = { tipo, atualizado_em: novo ? origemDoProduto(p) : (anterior?.atualizado_em ?? "") };
  }

  // --- 2. Vetores dos produtos --------------------------------------------------
  const precisamVetor = produtos.filter((p) => {
    if (opcoes.forcar || !vetoresAnteriores) return true;
    if (vetoresAnteriores.modelo !== modeloEmbedding) return true;
    const linha = vetoresAnteriores.linhaDe.get(p.id);
    return linha === undefined || vetoresAnteriores.origem[p.id] !== origemDoProduto(p);
  });

  const novosVetores = new Map<string, Float32Array>();
  let feitosVetor = 0;
  for (let i = 0; i < precisamVetor.length; i += LOTE_EMBEDDING) {
    const lote = precisamVetor.slice(i, i + LOTE_EMBEDDING);
    let vetores: Array<Float32Array | null>;
    try {
      vetores = await embeddingsDe(deps.embeddings, lote.map(textoDoProduto), modeloEmbedding);
    } catch {
      // Lote inteiro perdido: os produtos dele caem como falha e a trava decide.
      vetores = lote.map(() => null);
    }
    lote.forEach((p, k) => {
      const v = vetores[k];
      if (v) novosVetores.set(p.id, v);
    });
    feitosVetor += lote.length;
    opcoes.onProgresso?.({ fase: "vetor-produto", feitos: feitosVetor, total: precisamVetor.length });
  }

  // --- 3. Conferência e trava ----------------------------------------------------
  const temVetor = (p: ProdutoIndexado): boolean =>
    novosVetores.has(p.id) ||
    (!!vetoresAnteriores &&
      vetoresAnteriores.modelo === modeloEmbedding &&
      vetoresAnteriores.linhaDe.has(p.id));

  const falhas: ResultadoGeracao["falhas"] = [];
  for (const p of produtos) {
    const semTipo = !tabela.produtos[p.id]?.tipo;
    const semVetor = !temVetor(p);
    if (semTipo || semVetor) {
      falhas.push({
        id: p.id,
        nome: p.nome,
        erro: semTipo && semVetor ? "sem rótulo e sem vetor" : semTipo ? "sem rótulo" : "sem vetor",
      });
    }
  }

  const base: Omit<ResultadoGeracao, "travou" | "gravou"> = {
    produtos: produtos.length,
    rotulados: rotulagem.tipos.size,
    reaproveitadosRotulo: Object.keys(tabela.produtos).length - rotulagem.tipos.size,
    vetorizados: novosVetores.size,
    reaproveitadosVetor: produtos.filter((p) => !novosVetores.has(p.id) && temVetor(p)).length,
    tiposDistintos: new Set(Object.values(tabela.produtos).map((t) => t.tipo)).size,
    falhas,
  };

  if (produtos.length > 0 && falhas.length / produtos.length > MAX_FALHAS) {
    return { ...base, travou: true, gravou: false };
  }

  // --- 4. Monta a matriz final (novos + reaproveitados, na ordem do catálogo) ------
  const ids: string[] = [];
  const origem: Record<string, string> = {};
  const linhas: Float32Array[] = [];
  for (const p of produtos) {
    const novo = novosVetores.get(p.id);
    if (novo) {
      ids.push(p.id);
      origem[p.id] = origemDoProduto(p);
      linhas.push(novo);
      continue;
    }
    const linhaAnterior = vetoresAnteriores?.linhaDe.get(p.id);
    if (vetoresAnteriores && linhaAnterior !== undefined && vetoresAnteriores.modelo === modeloEmbedding) {
      const inicio = linhaAnterior * vetoresAnteriores.dimensao;
      ids.push(p.id);
      origem[p.id] = vetoresAnteriores.origem[p.id] ?? "";
      linhas.push(vetoresAnteriores.matriz.slice(inicio, inicio + vetoresAnteriores.dimensao));
    }
  }

  const dimensao = linhas[0]?.length ?? vetoresAnteriores?.dimensao ?? DIMENSAO_EMBEDDING;
  const matriz = new Float32Array(linhas.length * dimensao);
  linhas.forEach((v, i) => matriz.set(v, i * dimensao));

  await deps.tipos.salvar(tabela);
  await deps.vetoresProduto.salvar({
    modelo: modeloEmbedding,
    dimensao,
    gerado_em: agora().toISOString(),
    ids,
    origem,
    matriz,
  });

  // --- 5. Vetores dos tipos distintos ---------------------------------------------
  await gerarVetoresDeTipo(tabela, deps, { ...opcoes, modeloEmbedding, agora });

  return { ...base, travou: false, gravou: true };
}

/**
 * Um vetor por tipo distinto. São poucas centenas, e o texto é o próprio tipo,
 * então aqui a chave de reaproveitamento é o texto, não a data.
 */
async function gerarVetoresDeTipo(
  tabela: TabelaTipos,
  deps: DependenciasGeracao,
  opcoes: OpcoesGeracao & { modeloEmbedding: string; agora: () => Date }
): Promise<void> {
  const tipos = [...new Set(mapaDeTipos(tabela).values())].filter(Boolean).sort();
  if (tipos.length === 0) return;

  const anteriores = await deps.vetoresTipo.carregar();
  const aproveita = (t: string): Float32Array | null => {
    if (opcoes.forcar || !anteriores || anteriores.modelo !== opcoes.modeloEmbedding) return null;
    const linha = anteriores.linhaDe.get(t);
    if (linha === undefined) return null;
    const inicio = linha * anteriores.dimensao;
    return anteriores.matriz.slice(inicio, inicio + anteriores.dimensao);
  };

  const faltam = tipos.filter((t) => aproveita(t) === null);
  const novos = new Map<string, Float32Array>();
  let feitos = 0;
  for (let i = 0; i < faltam.length; i += LOTE_EMBEDDING) {
    const lote = faltam.slice(i, i + LOTE_EMBEDDING);
    try {
      const vetores = await embeddingsDe(deps.embeddings, lote, opcoes.modeloEmbedding);
      lote.forEach((t, k) => {
        const v = vetores[k];
        if (v) novos.set(t, v);
      });
    } catch {
      // sem vetor de tipo, o filtro por tipo não roda para ele; a busca segue pela ordem
    }
    feitos += lote.length;
    opcoes.onProgresso?.({ fase: "vetor-tipo", feitos, total: faltam.length });
  }

  const ids: string[] = [];
  const origem: Record<string, string> = {};
  const linhas: Float32Array[] = [];
  for (const t of tipos) {
    const v = novos.get(t) ?? aproveita(t);
    if (!v) continue;
    ids.push(t);
    origem[t] = t;
    linhas.push(v);
  }
  if (linhas.length === 0) return;

  const dimensao = linhas[0].length;
  const matriz = new Float32Array(linhas.length * dimensao);
  linhas.forEach((v, i) => matriz.set(v, i * dimensao));
  await deps.vetoresTipo.salvar({
    modelo: opcoes.modeloEmbedding,
    dimensao,
    gerado_em: opcoes.agora().toISOString(),
    ids,
    origem,
    matriz,
  });
}

/** Só para quem precisa do conjunto montado sem passar pelo store (testes e scripts). */
export function conjuntoDe(
  ids: string[],
  vetores: Float32Array[],
  modelo = MODELO_EMBEDDING,
  gerado_em = new Date().toISOString()
): ConjuntoVetores {
  const dimensao = vetores[0]?.length ?? DIMENSAO_EMBEDDING;
  const matriz = new Float32Array(ids.length * dimensao);
  vetores.forEach((v, i) => matriz.set(v, i * dimensao));
  const origem: Record<string, string> = {};
  for (const id of ids) origem[id] = id;
  return montarConjunto({ modelo, dimensao, gerado_em, ids, origem, matriz });
}
