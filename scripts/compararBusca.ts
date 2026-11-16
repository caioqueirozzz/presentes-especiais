/**
 * Medição da busca semântica (spec §8): BM25 × semântica, lado a lado.
 *
 *   npm run avaliar:recomendacao -- --comparar
 *   npm run avaliar:recomendacao -- --comparar --piso 0.45 --margem 0.20
 *   npm run avaliar:recomendacao -- --comparar --varrer
 *
 * Para cada uma das 40 consultas de `evals/recomendacao/consultas-semantica.json`,
 * roda os dois motores contra o MESMO índice e imprime o top-3 de cada um, com
 * nome, tipo, slug e o link da loja, mais uma coluna para o João marcar.
 *
 * Não chama `recomendar`: fica só no motor de busca, sem revalidação na API nem
 * cotação. O que se mede aqui é QUEM a busca escolhe, não se o estoque fecha —
 * e assim a medição não gasta milhares de chamadas.
 *
 * `--varrer` testa vários pisos e margens de uma vez e diz qual combinação zera
 * as armadilhas sem perder o produto certo. É o que calibra o número da spec.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { config } from "../src/config.js";
import { FileProductIndexStore, type ProdutoIndexado } from "../src/catalogo/indice.js";
import { FileTipoStore, arquivoTiposPadrao, canonizarTipo } from "../src/catalogo/tipos.js";
import { FileVectorStore, arquivosVetoresPadrao } from "../src/catalogo/vetores.js";
import { MotorSemantico, pontuarCatalogo, PISO_TIPO_PADRAO, MARGEM_TIPO_PADRAO } from "../src/catalogo/semantica.js";
import { clienteEmbeddingsPadrao } from "../src/llm/embeddings.js";
import { IndiceBM25 } from "../src/busca/bm25.js";
import { tokenizar } from "../src/busca/texto.js";
import { sinonimosDe } from "../src/busca/sinonimos.js";

const __dir = dirname(fileURLToPath(import.meta.url));

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GRAY = "\x1b[90m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const TOP = 3;

interface ConsultaJson {
  id: string;
  pedido: string;
  consulta: string;
  tipo_produto?: string;
  quantidade?: number;
  ocasiao?: string;
  /** Regex do produto de outro tipo que a busca lexical trazia junto. */
  armadilha?: string;
  origem?: string;
}

function numero(nome: string, padrao: number): number {
  const i = process.argv.indexOf(`--${nome}`);
  if (i === -1) return padrao;
  const n = Number.parseFloat(process.argv[i + 1] ?? "");
  return Number.isFinite(n) ? n : padrao;
}

/** O mesmo BM25 que a busca usa de reserva, montado aqui para comparar. */
function bm25De(produtos: ProdutoIndexado[]): IndiceBM25 {
  return new IndiceBM25(
    produtos.map((p) => ({
      id: p.id,
      campos: [
        { tokens: tokenizar(p.nome), peso: 3 },
        { tokens: tokenizar(p.slug.replace(/-/g, " ")), peso: 3 },
        { tokens: tokenizar(p.categorias.join(" ")), peso: 2 },
        { tokens: tokenizar(p.personalizacoes.join(" ")), peso: 1 },
        { tokens: tokenizar(p.descricao), peso: 1 },
      ],
    }))
  );
}

function topBm25(motor: IndiceBM25, consulta: string): string[] {
  const termos = [...new Set(tokenizar(consulta, { semGenericasDeProduto: true }))].map((t) => ({
    termo: t,
    alternativas: sinonimosDe(t),
  }));
  if (termos.length === 0) return [];
  return [...motor.pontuar(termos).entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, TOP)
    .map(([id]) => id);
}

const link = (p: ProdutoIndexado) => `https://presentesespeciais.com.br/brinde/${p.slug}`;

async function main() {
  const modo = config.brindeMe.mode === "http" ? "http" : "mock";
  const piso = numero("piso", PISO_TIPO_PADRAO);
  const margem = numero("margem", MARGEM_TIPO_PADRAO);

  if (!config.openaiApiKey) {
    console.error(`${RED}✗${RESET} OPENAI_API_KEY não está no .env: a medição precisa gerar o embedding de cada consulta.`);
    process.exit(1);
  }

  const arquivo = resolve(join(__dir, "../evals/recomendacao/consultas-semantica.json"));
  const consultas: ConsultaJson[] = JSON.parse(readFileSync(arquivo, "utf-8")).consultas;

  const produtos = new FileProductIndexStore().carregar().produtos;
  if (produtos.length === 0) {
    console.error(`${RED}✗${RESET} índice vazio. Rode antes: npm run sync:catalogo`);
    process.exit(1);
  }

  const prod = arquivosVetoresPadrao("produto", modo);
  const tipoArq = arquivosVetoresPadrao("tipo", modo);
  const motor = new MotorSemantico({
    vetoresProduto: new FileVectorStore(prod.bin, prod.meta),
    vetoresTipo: new FileVectorStore(tipoArq.bin, tipoArq.meta),
    tipos: new FileTipoStore(arquivoTiposPadrao(modo)),
    embeddings: clienteEmbeddingsPadrao(config.openaiApiKey),
    piso,
    margem,
  });

  const retrato = await motor.retrato();
  if (!retrato) {
    console.error(`${RED}✗${RESET} sem vetores. Rode antes: npm run gerar:vetores`);
    process.exit(1);
  }

  const porId = new Map(produtos.map((p) => [p.id, p]));
  const ids = produtos.map((p) => p.id);
  const bm25 = bm25De(produtos);

  console.log(`${BOLD}BM25 × semântica — ${config.storeName}${RESET}`);
  console.log(`${GRAY}  ${consultas.length} consulta(s) · ${produtos.length} produto(s) · modo ${modo} · piso ${piso} · margem ${margem}${RESET}\n`);

  // Um embedding por consulta e um por tipo, reaproveitados por toda a varredura.
  const vetores = new Map<string, { consulta: Float32Array; tipo: Float32Array | null }>();
  for (const c of consultas) {
    const vc = await motor.embedding(c.consulta);
    if (!vc) {
      console.error(`${RED}✗${RESET} embedding falhou para "${c.consulta}"`);
      process.exit(1);
    }
    vetores.set(c.id, { consulta: vc, tipo: c.tipo_produto ? await motor.embedding(c.tipo_produto) : null });
  }

  /**
   * O catálogo tem produto do tipo pedido? Sem isso, "consulta sem resultado"
   * contaria como erro o `nenhum_do_tipo` CERTO — a loja não vender guarda-chuva
   * é resposta correta, não falha de busca. Só é perda quando o produto existe e
   * mesmo assim não apareceu.
   */
  const catalogoTem = (tipoPedido: string): boolean => {
    const alvo = canonizarTipo(tipoPedido);
    for (const t of retrato.tipos.values()) if (canonizarTipo(t) === alvo) return true;
    return false;
  };

  const topSemantico = (c: ConsultaJson, p: number, m: number): string[] => {
    const v = vetores.get(c.id)!;
    const notas = pontuarCatalogo(ids, retrato, v.consulta, v.tipo, p, m);
    return [...notas.entries()]
      .sort((a, b) => b[1].similaridade - a[1].similaridade)
      .slice(0, TOP)
      .map(([id]) => id);
  };

  // --- varredura de piso e margem ------------------------------------------------
  if (process.argv.includes("--varrer")) {
    console.log(`${BOLD}Varredura${RESET} ${GRAY}(armadilhas = itens de outro tipo no top-3; vazios = consulta que perdeu todo resultado)${RESET}\n`);
    console.log("| piso | margem | armadilhas | consultas vazias | com tipo |");
    console.log("|---|---|---|---|---|");
    for (const p of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75]) {
      for (const m of [0.1, 0.15, 0.2, 0.25, 1]) {
        let armadilhas = 0;
        let vazias = 0;
        for (const c of consultas) {
          const top = topSemantico(c, p, m);
          if (c.tipo_produto && top.length === 0 && catalogoTem(c.tipo_produto)) vazias++;
          if (c.armadilha) {
            const re = new RegExp(c.armadilha, "i");
            armadilhas += top.filter((id) => re.test(porId.get(id)?.nome ?? "")).length;
          }
        }
        const marca = armadilhas === 0 && vazias === 0 ? `${GREEN} ✓${RESET}` : "";
        console.log(`| ${p.toFixed(2)} | ${m === 1 ? "sem" : m.toFixed(2)} | ${armadilhas} | ${vazias} |${marca} |`);
      }
    }
    console.log("");
  }

  // --- comparação consulta a consulta ---------------------------------------------
  const linhas: string[] = [
    `# Busca semântica: BM25 × semântica`,
    "",
    `**Data:** ${new Date().toISOString().slice(0, 10)} · **Índice:** ${produtos.length} produtos (${modo}) · **Piso:** ${piso} · **Margem:** ${margem}`,
    "",
    "Marque na última coluna qual motor acertou: `BM25`, `semântica`, `empate` ou `nenhum`.",
    "A spec pede empate ou vitória da semântica em pelo menos 80% das 40 consultas (§2.2).",
    "",
  ];

  let armadilhasBm25 = 0;
  let armadilhasSemantica = 0;
  let vaziasSemantica = 0;

  for (const c of consultas) {
    const top = topSemantico(c, piso, margem);
    const lex = topBm25(bm25, c.consulta);
    const re = c.armadilha ? new RegExp(c.armadilha, "i") : null;
    const pegou = (ids: string[]) => (re ? ids.filter((id) => re.test(porId.get(id)?.nome ?? "")).length : 0);
    armadilhasBm25 += pegou(lex);
    armadilhasSemantica += pegou(top);
    if (c.tipo_produto && top.length === 0 && catalogoTem(c.tipo_produto)) vaziasSemantica++;

    const descreve = (id: string): string => {
      const p = porId.get(id);
      if (!p) return id;
      const tipo = retrato.tipos.get(id) ?? "—";
      const alerta = re && re.test(p.nome) ? " ⚠️" : "";
      return `[${p.nome}](${link(p)})${alerta}<br>_tipo: ${tipo}_`;
    };

    const parametros = [
      c.tipo_produto ? `tipo_produto: \`${c.tipo_produto}\`` : "_sem tipo_produto_",
      c.quantidade ? `${c.quantidade} un` : null,
      c.ocasiao ? `ocasião ${c.ocasiao}` : null,
      c.origem === "dogfooding-fase-0" ? "**(dogfooding)**" : null,
    ]
      .filter(Boolean)
      .join(" · ");

    linhas.push(`### ${c.id} — ${c.pedido}`, `_${parametros}_`, "");
    linhas.push("| # | BM25 (hoje) | Semântica (nova) | Quem acertou? |", "|---|---|---|---|");
    for (let i = 0; i < TOP; i++) {
      linhas.push(`| ${i + 1} | ${lex[i] ? descreve(lex[i]) : "—"} | ${top[i] ? descreve(top[i]) : "—"} | ${i === 0 ? "" : ""} |`);
    }
    linhas.push("", `**Veredito (${c.id}):** _____`, "");

    const sinal = pegou(top) > 0 ? `${RED}✗${RESET}` : pegou(lex) > 0 ? `${GREEN}✓${RESET}` : `${GRAY}·${RESET}`;
    console.log(
      `${sinal} ${c.id} ${c.consulta.padEnd(28)} ${GRAY}BM25:${RESET} ${lex.length} ${GRAY}sem:${RESET} ${top.length}${
        c.armadilha ? ` ${GRAY}armadilha BM25 ${pegou(lex)} → sem ${pegou(top)}${RESET}` : ""
      }`
    );
  }

  // Fora do repo, como os outros relatórios de avaliação (spec §8).
  const destino = join(__dir, "../../Validações");
  mkdirSync(destino, { recursive: true });
  const saida = join(destino, "busca-semantica-comparacao.md");
  writeFileSync(saida, linhas.join("\n"), "utf-8");

  console.log("");
  console.log(`${BOLD}Resumo${RESET}`);
  console.log(`  armadilhas no top-3 — BM25: ${armadilhasBm25}   semântica: ${armadilhasSemantica}`);
  console.log(`  produto do tipo existe no catálogo e NÃO apareceu: ${vaziasSemantica}`);
  console.log(`${GRAY}  (nenhum_do_tipo para tipo que a loja não vende é resposta certa, não entra na conta)${RESET}`);
  console.log(`${GRAY}  comparação para o João: ${saida}${RESET}`);

  if (armadilhasSemantica > 0 || vaziasSemantica > 0) {
    console.log(
      `${YELLOW}!${RESET} a calibração ainda não fecha o critério da spec §8: rode com --varrer para achar piso e margem.`
    );
    process.exitCode = 1;
  } else {
    console.log(`${GREEN}✓${RESET} nenhuma armadilha e nenhuma consulta vazia com piso ${piso} e margem ${margem}.`);
  }
}

main().catch((err) => {
  console.error(`${RED}✗${RESET} comparação abortada: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
