import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryProductIndexStore, sincronizarCatalogo } from "../src/catalogo/indice.js";
import { MemoryOccasionTagStore } from "../src/catalogo/ocasioes.js";
import { recomendar, type Recomendacao } from "../src/catalogo/recomendar.js";
import { MotorSemantico, pontuarCatalogo } from "../src/catalogo/semantica.js";
import { MemoryVectorStore, normalizar, montarConjunto } from "../src/catalogo/vetores.js";
import { MemoryTipoStore, recarregarCorrecoesDeTipo, type TabelaTipos } from "../src/catalogo/tipos.js";
import { setLogBusca, type BuscaDegradada } from "../src/catalogo/logBusca.js";
import type { ClienteEmbeddings } from "../src/llm/embeddings.js";
import { ClienteCatalogoFalso, produto, sub } from "./helpers/produtos.js";

/**
 * Espaço de 4 dimensões, uma por "conceito". Dois textos do mesmo conceito têm
 * cosseno 1; de conceitos diferentes, 0. É o bastante para provar o filtro: o
 * que importa é passar ou não do piso, não o valor exato.
 */
const CONCEITOS = ["camiseta", "caneca", "miniatura de empilhadeira", "miniatura de carro"];

function vetorDoConceito(conceito: string): number[] {
  const v = new Array(CONCEITOS.length).fill(0);
  const i = CONCEITOS.indexOf(conceito);
  if (i >= 0) v[i] = 1;
  return v;
}

/** Mapeia cada texto conhecido ao seu conceito; o que não conhece vira vetor nulo. */
const TEXTOS: Record<string, string> = {
  // tipos
  camiseta: "camiseta",
  "porta-latas": "camiseta-nao", // porta-latas NÃO é camiseta: fica sem conceito, cosseno 0
  caneca: "caneca",
  escova: "escova",
  "miniatura de empilhadeira": "miniatura de empilhadeira",
  "miniatura de carro": "miniatura de carro",
  // consultas
  "camisa dry fit": "camiseta",
  "caneca magica": "caneca",
  "miniatura de empilhadeira 200": "miniatura de empilhadeira",
};

function embeddingsFalso(opcoes: { falhar?: boolean } = {}): ClienteEmbeddings {
  return {
    embeddings: {
      async create(body: { model: string; input: string[] }) {
        if (opcoes.falhar) throw new Error("openai fora do ar");
        return {
          data: body.input.map((texto) => {
            const conceito = TEXTOS[texto.toLowerCase()] ?? acharConceito(texto);
            return { embedding: vetorDoConceito(conceito) };
          }),
        };
      },
    },
  };
}

/** Texto de produto ("Camisa Dry Fit · Vestuário · ...") cai no conceito que ele contém. */
function acharConceito(texto: string): string {
  const t = texto.toLowerCase();
  if (t.includes("porta lata") || t.includes("porta-lata")) return "porta-latas";
  if (t.includes("camisa")) return "camiseta";
  if (t.includes("escova")) return "escova";
  if (t.includes("caneca")) return "caneca";
  if (t.includes("empilhadeira")) return "miniatura de empilhadeira";
  if (t.includes("carro")) return "miniatura de carro";
  return "";
}

/** Os produtos reais do dogfooding de 09/11, com as palavras que confundiam o BM25. */
function catalogoDoDogfooding() {
  return [
    produto({
      id: "camisa",
      nome: "Camisa Dry Fit Personalizada",
      categoria: "Vestuário",
      min: 10,
      subprodutos: [sub("camisa-azul", "Azul", 500, [[10, 999, 29.9]])],
    }),
    produto({
      id: "porta-latas",
      nome: "Porta Latas Camisa Personalizado",
      categoria: "Bebidas",
      min: 10,
      subprodutos: [sub("pl-branco", "Branco", 500, [[10, 999, 9.9]])],
    }),
    produto({
      id: "caneca-magica",
      nome: "Caneca Mágica Personalizada",
      categoria: "Canecas",
      min: 50,
      subprodutos: [sub("cm-preta", "Preta", 500, [[50, 999, 24.9]])],
    }),
    produto({
      id: "escova",
      nome: "Escova Mágica para Cabelo",
      categoria: "Beleza",
      min: 10,
      subprodutos: [sub("esc-rosa", "Rosa", 500, [[10, 999, 12.9]])],
    }),
    produto({
      id: "empilhadeira",
      nome: "Miniatura Empilhadeira Metal",
      categoria: "Colecionáveis",
      min: 20,
      // estoque só para 50: o pedido de 200 do dogfooding não fecha
      subprodutos: [sub("emp-amarela", "Amarela", 50, [[20, 999, 31.27]])],
    }),
    produto({
      id: "carro",
      nome: "Carro Miniatura Fusca Metal",
      categoria: "Colecionáveis",
      min: 20,
      subprodutos: [sub("carro-azul", "Azul", 900, [[20, 999, 28.0]])],
    }),
  ];
}

const TIPOS: TabelaTipos = {
  versao: 1,
  produtos: {
    camisa: { tipo: "camiseta", atualizado_em: "" },
    "porta-latas": { tipo: "porta-latas", atualizado_em: "" },
    "caneca-magica": { tipo: "caneca", atualizado_em: "" },
    escova: { tipo: "escova", atualizado_em: "" },
    empilhadeira: { tipo: "miniatura de empilhadeira", atualizado_em: "" },
    carro: { tipo: "miniatura de carro", atualizado_em: "" },
  },
};

async function montar(opcoes: { semVetores?: boolean; semVetoresDeTipo?: boolean; falharEmbedding?: boolean } = {}) {
  const client = new ClienteCatalogoFalso(catalogoDoDogfooding());
  const index = new MemoryProductIndexStore();
  await sincronizarCatalogo(client, index, { agora: new Date("2026-11-09T10:00:00Z") });

  const produtos = index.carregar().produtos;
  const vetoresProduto = new MemoryVectorStore();
  const vetoresTipo = new MemoryVectorStore();

  if (!opcoes.semVetores) {
    const dim = CONCEITOS.length;
    const matriz = new Float32Array(produtos.length * dim);
    produtos.forEach((p, i) => {
      matriz.set(normalizar(vetorDoConceito(acharConceito(`${p.nome} ${p.categorias.join(" ")}`))), i * dim);
    });
    await vetoresProduto.salvar({
      modelo: "falso",
      dimensao: dim,
      gerado_em: "",
      ids: produtos.map((p) => p.id),
      origem: {},
      matriz,
    });
  }

  if (!opcoes.semVetores && !opcoes.semVetoresDeTipo) {
    const tipos = [...new Set(Object.values(TIPOS.produtos).map((t) => t.tipo))].sort();
    const dim = CONCEITOS.length;
    const matriz = new Float32Array(tipos.length * dim);
    tipos.forEach((t, i) => matriz.set(normalizar(vetorDoConceito(TEXTOS[t] ?? t)), i * dim));
    await vetoresTipo.salvar({ modelo: "falso", dimensao: dim, gerado_em: "", ids: tipos, origem: {}, matriz });
  }

  const semantica = new MotorSemantico({
    vetoresProduto,
    vetoresTipo,
    tipos: new MemoryTipoStore(TIPOS),
    embeddings: embeddingsFalso({ falhar: opcoes.falharEmbedding }),
    piso: 0.6,
  });

  return { client, index, tags: new MemoryOccasionTagStore({ porProduto: {}, porSku: {}, porCategoria: {} }), semantica };
}

function nomes(r: Recomendacao): string[] {
  return r.tipo === "encontrados" ? r.itens.map((i) => i.produto.nome) : [];
}

let degradacoes: BuscaDegradada[] = [];

beforeEach(() => {
  recarregarCorrecoesDeTipo();
  degradacoes = [];
  setLogBusca((e) => degradacoes.push(e));
});

afterEach(() => setLogBusca(null));

describe("filtro por tipo — os casos do dogfooding de 09/11", () => {
  it("[dogfooding 1] 'camisas dry fit' não traz o Porta Latas Camisa", async () => {
    const { client, index, tags, semantica } = await montar();
    const r = await recomendar(
      { consulta: "camisa dry fit", tipoProduto: "camiseta", quantidade: 10 },
      { index, tags, client, semantica }
    );
    expect(r.tipo).toBe("encontrados");
    expect(nomes(r)).toEqual(["Camisa Dry Fit Personalizada"]);
    expect(nomes(r).join(" ")).not.toContain("Porta Latas");
  });

  it("[dogfooding 2] 'canecas mágicas' não traz a Escova Mágica", async () => {
    const { client, index, tags, semantica } = await montar();
    const r = await recomendar(
      { consulta: "caneca magica", tipoProduto: "caneca", quantidade: 50 },
      { index, tags, client, semantica }
    );
    expect(nomes(r)).toEqual(["Caneca Mágica Personalizada"]);
    expect(nomes(r).join(" ")).not.toContain("Escova");
  });

  it("[dogfooding 3] miniatura de empilhadeira sem estoque não vira carro miniatura", async () => {
    const { client, index, tags, semantica } = await montar();
    const r = await recomendar(
      { consulta: "miniatura de empilhadeira 200", tipoProduto: "miniatura de empilhadeira", quantidade: 200 },
      { index, tags, client, semantica }
    );
    // o tipo existe, mas o estoque não fecha: cai no "nenhum" com ajuste do MESMO produto
    expect(r.tipo).toBe("nenhum");
    if (r.tipo !== "nenhum") return;
    expect(r.motivo).toBe("regras_nao_fecham");
    expect(r.ajustes.every((a) => a.produto_id === "empilhadeira")).toBe(true);
    expect(JSON.stringify(r.ajustes)).not.toContain("Carro");
  });
});

describe("nenhum_do_tipo", () => {
  it("tipo que a loja não tem devolve nenhum_do_tipo, sem cartões e sem vizinho", async () => {
    const { client, index, tags, semantica } = await montar();
    const r = await recomendar(
      { consulta: "guarda-chuva personalizado", tipoProduto: "guarda-chuva", quantidade: 10 },
      { index, tags, client, semantica }
    );
    expect(r.tipo).toBe("nenhum_do_tipo");
    if (r.tipo !== "nenhum_do_tipo") return;
    expect(r.tipoPedido).toBe("guarda-chuva");
  });

  it("produto sem tipo não entra no filtro", async () => {
    const { client, index, tags, semantica } = await montar();
    // tira o tipo da camisa: ela deixa de ser candidata a "camiseta"
    const tiposSemCamisa = { ...TIPOS, produtos: { ...TIPOS.produtos } };
    delete (tiposSemCamisa.produtos as Record<string, unknown>).camisa;
    const motor = new MotorSemantico({
      vetoresProduto: (semantica as unknown as { deps: { vetoresProduto: MemoryVectorStore } }).deps.vetoresProduto,
      vetoresTipo: (semantica as unknown as { deps: { vetoresTipo: MemoryVectorStore } }).deps.vetoresTipo,
      tipos: new MemoryTipoStore(tiposSemCamisa),
      embeddings: embeddingsFalso(),
      piso: 0.6,
    });
    const r = await recomendar(
      { consulta: "camisa dry fit", tipoProduto: "camiseta", quantidade: 10 },
      { index, tags, client, semantica: motor }
    );
    expect(r.tipo).toBe("nenhum_do_tipo");
  });
});

describe("BM25 de reserva", () => {
  it("sem vetores gerados, a busca roda lexical e loga uma vez", async () => {
    const { client, index, tags, semantica } = await montar({ semVetores: true });
    const r = await recomendar(
      { consulta: "camisa dry fit", tipoProduto: "camiseta", quantidade: 10 },
      { index, tags, client, semantica }
    );
    // comportamento antigo: o porta-latas volta a aparecer, e é por isso que o log existe
    expect(r.tipo).toBe("encontrados");
    expect(degradacoes.map((d) => d.motivo)).toEqual(["sem_vetores"]);

    await recomendar({ consulta: "camisa dry fit", tipoProduto: "camiseta", quantidade: 10 }, { index, tags, client, semantica });
    expect(degradacoes).toHaveLength(1); // uma vez por carga, não por pergunta
  });

  it("embedding que falha cai no BM25 e loga o motivo", async () => {
    const { client, index, tags, semantica } = await montar({ falharEmbedding: true });
    const r = await recomendar(
      { consulta: "camisa dry fit", tipoProduto: "camiseta", quantidade: 10 },
      { index, tags, client, semantica }
    );
    expect(r.tipo).toBe("encontrados");
    expect(degradacoes[0].motivo).toBe("embedding_falhou");
  });

  it("sem vetores de tipo não finge que filtrou", async () => {
    const { client, index, tags, semantica } = await montar({ semVetoresDeTipo: true });
    await recomendar(
      { consulta: "camisa dry fit", tipoProduto: "camiseta", quantidade: 10 },
      { index, tags, client, semantica }
    );
    expect(degradacoes[0].motivo).toBe("sem_vetores_de_tipo");
    expect(degradacoes[0].tipo_pedido).toBe("camiseta");
  });

  it("sem motor semântico nada muda: é o caminho de antes", async () => {
    const { client, index, tags } = await montar();
    const r = await recomendar({ consulta: "camisa", quantidade: 10 }, { index, tags, client });
    expect(r.tipo).toBe("encontrados");
    expect(degradacoes).toEqual([]);
  });
});

describe("sem tipo_produto", () => {
  it("ordena pelo cosseno e não filtra ('algo para professores')", async () => {
    const { client, index, tags, semantica } = await montar();
    const r = await recomendar({ consulta: "caneca magica", quantidade: 50 }, { index, tags, client, semantica });
    expect(r.tipo).toBe("encontrados");
    // a caneca vem na frente pelo cosseno, mas o filtro por tipo não rodou
    expect(nomes(r)[0]).toBe("Caneca Mágica Personalizada");
  });
});

describe("piso absoluto e margem relativa (calibração, spec §8)", () => {
  /**
   * Espaço de 2 dimensões: o ângulo entre dois vetores é escolhido para
   * reproduzir os cossenos medidos na calibração.
   */
  function noAngulo(graus: number): Float32Array {
    const r = (graus * Math.PI) / 180;
    return normalizar([Math.cos(r), Math.sin(r)]);
  }

  function retratoDe(tiposPorProduto: Record<string, string>, angulos: Record<string, number>) {
    const tipos = [...new Set(Object.values(tiposPorProduto))];
    const dim = 2;
    const matrizTipo = new Float32Array(tipos.length * dim);
    tipos.forEach((t, i) => matrizTipo.set(noAngulo(angulos[t] ?? 90), i * dim));

    const ids = Object.keys(tiposPorProduto);
    const matrizProduto = new Float32Array(ids.length * dim);
    ids.forEach((_, i) => matrizProduto.set(noAngulo(0), i * dim));

    return {
      vetores: montarConjunto({ modelo: "f", dimensao: dim, gerado_em: "", ids, origem: {}, matriz: matrizProduto }),
      vetoresTipo: montarConjunto({ modelo: "f", dimensao: dim, gerado_em: "", ids: tipos, origem: {}, matriz: matrizTipo }),
      tipos: new Map(Object.entries(tiposPorProduto)),
    };
  }

  // 0° → cosseno 1,000 (tipo exato); 44° → ~0,719 (o "miniatura de carro" medido);
  // 68° → ~0,375 (a faixa de ruído onde o tipo errado pontua igual ao certo).
  const retrato = retratoDe(
    { empilhadeira: "miniatura de empilhadeira", carro: "miniatura de carro", chaveiro: "chaveiro" },
    { "miniatura de empilhadeira": 0, "miniatura de carro": 44, chaveiro: 68 }
  );
  const consulta = noAngulo(0);
  const tipoPedido = noAngulo(0);

  it("a margem tira o tipo vizinho que o piso sozinho deixaria passar", () => {
    const comMargem = pontuarCatalogo(["empilhadeira", "carro", "chaveiro"], retrato, consulta, tipoPedido, 0.6, 0.2);
    expect([...comMargem.keys()]).toEqual(["empilhadeira"]);

    // Sem margem (1 = desligada), o carro a 0,719 passa do piso 0,6 — era o furo.
    const semMargem = pontuarCatalogo(["empilhadeira", "carro", "chaveiro"], retrato, consulta, tipoPedido, 0.6, 1);
    expect([...semMargem.keys()]).toEqual(["empilhadeira", "carro"]);
  });

  it("o piso barra a faixa de ruído: tipo que a loja não tem vira nenhum_do_tipo", () => {
    const soRuido = retratoDe({ chaveiro: "chaveiro" }, { chaveiro: 68 });
    const notas = pontuarCatalogo(["chaveiro"], soRuido, consulta, tipoPedido, 0.6, 0.2);
    expect(notas.size).toBe(0);
  });

  it("um tipo vetorizado que nenhum produto usa não define a régua", () => {
    // "miniatura de empilhadeira" existe entre os vetores de tipo, mas nenhum
    // produto o carrega: quem manda é o melhor tipo EM USO.
    const semProdutoDoTipo = {
      ...retrato,
      tipos: new Map([["carro", "miniatura de carro"]]),
    };
    const notas = pontuarCatalogo(["carro"], semProdutoDoTipo, consulta, tipoPedido, 0.6, 0.2);
    expect([...notas.keys()]).toEqual(["carro"]);
  });
});
