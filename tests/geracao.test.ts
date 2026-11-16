import { describe, it, expect } from "vitest";
import { gerarTiposEVetores, MAX_FALHAS } from "../src/catalogo/geracao.js";
import { MemoryTipoStore, recarregarCorrecoesDeTipo } from "../src/catalogo/tipos.js";
import { MemoryVectorStore } from "../src/catalogo/vetores.js";
import type { ClienteEmbeddings } from "../src/llm/embeddings.js";
import type { ClienteRotulo } from "../src/llm/rotulador.js";
import type { ProdutoIndexado } from "../src/catalogo/indice.js";

const DIM = 4;

function produtoIndexado(id: string, nome: string, atualizadoEm = "2026-11-01"): ProdutoIndexado {
  return {
    id,
    slug: id,
    codigo: id,
    sku: `sku-${id}`,
    nome,
    descricao: `${nome} para sua marca.`,
    categorias: ["Brindes"],
    destaque: false,
    quantidade_minima: 1,
    imagem_url: null,
    personalizacoes: [],
    subprodutos: [],
    etiquetas_embutidas: [],
    atualizado_em: atualizadoEm,
    sincronizado_em: "2026-11-01T00:00:00.000Z",
    ausencias: 0,
  };
}

/** Embeddings determinísticos: uma dimensão por letra inicial, sem rede. */
function embeddingsFalso(opcoes: { falharPara?: (texto: string) => boolean } = {}): ClienteEmbeddings & { chamadas: number } {
  const cliente = {
    chamadas: 0,
    embeddings: {
      async create(body: { model: string; input: string[] }) {
        cliente.chamadas++;
        return {
          data: body.input.map((texto) => {
            if (opcoes.falharPara?.(texto)) return { embedding: [] as number[] };
            const v = new Array(DIM).fill(0);
            v[texto.charCodeAt(0) % DIM] = 1;
            return { embedding: v };
          }),
        };
      },
    },
  };
  return cliente;
}

/** Rotulador falso: devolve a primeira palavra do nome, ou falha nos ids pedidos. */
function rotuloFalso(opcoes: { falharIds?: string[] } = {}): ClienteRotulo & { chamadas: number } {
  const falhar = new Set(opcoes.falharIds ?? []);
  const cliente = {
    chamadas: 0,
    chat: {
      completions: {
        async create(body: { messages: Array<{ role: string; content: string }> }) {
          cliente.chamadas++;
          const pedido = body.messages[body.messages.length - 1].content;
          const nome = /Nome: (.*)/.exec(pedido)?.[1] ?? "";
          // o id não viaja no prompt; o nome do fixture carrega o id para o teste poder falhar nele
          if ([...falhar].some((id) => nome.includes(id))) return { choices: [{ message: { content: "{}" } }] };
          return { choices: [{ message: { content: JSON.stringify({ tipo: nome.split(" ")[0] }) } }] };
        },
      },
    },
  };
  return cliente;
}

function deps(extra: Partial<Parameters<typeof gerarTiposEVetores>[1]> = {}) {
  return {
    tipos: new MemoryTipoStore(),
    vetoresProduto: new MemoryVectorStore(),
    vetoresTipo: new MemoryVectorStore(),
    embeddings: embeddingsFalso(),
    rotulos: rotuloFalso(),
    agora: () => new Date("2026-11-16T12:00:00Z"),
    ...extra,
  };
}

describe("geração de tipos e vetores", () => {
  it("rotula, vetoriza e grava os três arquivos", async () => {
    recarregarCorrecoesDeTipo();
    const d = deps();
    const produtos = [produtoIndexado("p1", "caneca porcelana"), produtoIndexado("p2", "camiseta algodao")];

    const r = await gerarTiposEVetores(produtos, d);

    expect(r.gravou).toBe(true);
    expect(r.travou).toBe(false);
    expect(r.rotulados).toBe(2);
    expect(r.vetorizados).toBe(2);
    expect(r.tiposDistintos).toBe(2);
    expect(r.falhas).toEqual([]);

    const tabela = await d.tipos.carregar();
    expect(tabela.produtos.p1.tipo).toBe("caneca");
    expect(tabela.produtos.p2.tipo).toBe("camiseta");

    const vetores = await d.vetoresProduto.carregar();
    expect(vetores!.ids).toEqual(["p1", "p2"]);
    expect(vetores!.matriz.length).toBe(2 * DIM);

    const tipos = await d.vetoresTipo.carregar();
    expect(tipos!.ids).toEqual(["camiseta", "caneca"]);
  });

  it("a trava de 5% impede gravar catálogo meio rotulado", async () => {
    recarregarCorrecoesDeTipo();
    // 10 produtos, 2 sem rótulo = 20%, acima do limite
    const produtos = Array.from({ length: 10 }, (_, i) => produtoIndexado(`g${i}`, `caneca g${i}`));
    const d = deps({ rotulos: rotuloFalso({ falharIds: ["g0", "g1"] }) });

    const r = await gerarTiposEVetores(produtos, d);

    expect(r.travou).toBe(true);
    expect(r.gravou).toBe(false);
    expect(r.falhas).toHaveLength(2);
    expect(r.falhas.map((f) => f.id).sort()).toEqual(["g0", "g1"]);
    expect(r.falhas[0].erro).toBe("sem rótulo");
    // nada gravado: o que valia antes continua valendo
    expect((await d.tipos.carregar()).produtos).toEqual({});
    expect(await d.vetoresProduto.carregar()).toBeNull();
  });

  it("falha dentro do limite grava e só lista quem ficou de fora", async () => {
    recarregarCorrecoesDeTipo();
    // 40 produtos, 1 sem rótulo = 2,5%, dentro do limite
    const produtos = Array.from({ length: 40 }, (_, i) => produtoIndexado(`h${i}`, `caneca h${i}`));
    const d = deps({ rotulos: rotuloFalso({ falharIds: ["h7"] }) });

    const r = await gerarTiposEVetores(produtos, d);

    expect(r.travou).toBe(false);
    expect(r.gravou).toBe(true);
    expect(r.falhas.map((f) => f.id)).toEqual(["h7"]);
    const tabela = await d.tipos.carregar();
    expect(tabela.produtos.h7).toBeUndefined();
    expect(Object.keys(tabela.produtos)).toHaveLength(39);
    // h7 continua no catálogo e no vetor: entra pelo BM25, só fica fora do filtro de tipo
    expect(1 / 40).toBeLessThanOrEqual(MAX_FALHAS);
  });

  it("produto sem vetor também conta para a trava", async () => {
    recarregarCorrecoesDeTipo();
    const produtos = Array.from({ length: 10 }, (_, i) => produtoIndexado(`v${i}`, `caneca v${i}`));
    const d = deps({ embeddings: embeddingsFalso({ falharPara: (t) => t.includes("v3") || t.includes("v4") }) });

    const r = await gerarTiposEVetores(produtos, d);

    expect(r.travou).toBe(true);
    expect(r.falhas.map((f) => f.id).sort()).toEqual(["v3", "v4"]);
    expect(r.falhas[0].erro).toBe("sem vetor");
  });

  it("segunda rodada só mexe no que mudou", async () => {
    recarregarCorrecoesDeTipo();
    const d = deps();
    const produtos = [produtoIndexado("r1", "caneca porcelana"), produtoIndexado("r2", "camiseta algodao")];
    await gerarTiposEVetores(produtos, d);

    const rotulos = rotuloFalso();
    const embeddings = embeddingsFalso();
    const r = await gerarTiposEVetores(
      [produtos[0], produtoIndexado("r2", "mochila executiva", "2026-11-09")],
      { ...d, rotulos, embeddings }
    );

    expect(r.rotulados).toBe(1);
    expect(r.vetorizados).toBe(1);
    expect(r.reaproveitadosRotulo).toBe(1);
    expect(r.reaproveitadosVetor).toBe(1);
    expect(rotulos.chamadas).toBe(1);
    expect((await d.tipos.carregar()).produtos.r2.tipo).toBe("mochila");
    // o vetor de r1 sobreviveu intacto
    const vetores = await d.vetoresProduto.carregar();
    expect(vetores!.ids).toEqual(["r1", "r2"]);
  });

  it("--forcar refaz tudo", async () => {
    recarregarCorrecoesDeTipo();
    const d = deps();
    const produtos = [produtoIndexado("f1", "caneca porcelana")];
    await gerarTiposEVetores(produtos, d);

    const rotulos = rotuloFalso();
    const r = await gerarTiposEVetores(produtos, { ...d, rotulos }, { forcar: true });

    expect(r.rotulados).toBe(1);
    expect(r.vetorizados).toBe(1);
    expect(rotulos.chamadas).toBe(1);
  });

  it("catálogo vazio não trava nem grava matriz inválida", async () => {
    recarregarCorrecoesDeTipo();
    const d = deps();
    const r = await gerarTiposEVetores([], d);
    expect(r.travou).toBe(false);
    expect(r.produtos).toBe(0);
    expect((await d.vetoresProduto.carregar())!.ids).toEqual([]);
  });
});
