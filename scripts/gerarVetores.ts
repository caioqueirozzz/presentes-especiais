/**
 * Geração dos tipos e dos vetores do catálogo (busca semântica).
 *
 *   npm run gerar:vetores                 # só o que mudou desde a última vez
 *   npm run gerar:vetores -- --forcar     # rotula e vetoriza tudo de novo
 *   npm run gerar:vetores -- --concorrencia 3
 *
 * Lê o índice já sincronizado e grava no banco (schema agente): agente.tipos_produto,
 * agente.vetores_produto e agente.vetores_tipo. Só roda em BRINDEME_MODE=http: no mock
 * os vetores nascem em memória a cada partida e nunca vão ao banco.
 *
 * Com mais de 5% dos produtos sem rótulo ou sem vetor, NADA é gravado e o
 * processo sai com código 1: catálogo meio rotulado esconde produto do cliente.
 */
import "dotenv/config";
import { config } from "../src/config.js";
import { abrirSemanticaHttp, carregarIndiceDeScript } from "../src/catalogo/abrir.js";
import { gerarTiposEVetores, MAX_FALHAS } from "../src/catalogo/geracao.js";
import { clienteEmbeddingsPadrao } from "../src/llm/embeddings.js";
import { clienteRotuloPadrao, CONCORRENCIA_ROTULO } from "../src/llm/rotulador.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GRAY = "\x1b[90m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function numero(nome: string, padrao: number): number {
  const i = process.argv.indexOf(`--${nome}`);
  if (i === -1) return padrao;
  const n = Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

/**
 * O corpo da geração, com a saída no terminal. Devolve `false` quando a trava
 * disparou ou faltou configuração — o `sync:catalogo` chama isto no fim e
 * precisa saber se os vetores acompanharam o índice novo.
 */
export async function gerarEImprimir(opcoesCli: { forcar?: boolean; concorrencia?: number } = {}): Promise<boolean> {
  const forcar = opcoesCli.forcar ?? process.argv.includes("--forcar");
  const concorrencia = opcoesCli.concorrencia ?? numero("concorrencia", CONCORRENCIA_ROTULO);

  if (!config.openaiApiKey) {
    console.error(`${RED}✗${RESET} OPENAI_API_KEY não está no .env: a geração chama a OpenAI (rótulos e embeddings).`);
    return false;
  }

  const alvo = await abrirSemanticaHttp("gerar:vetores");
  if (!alvo) return false;
  try {
    return await gerar(alvo, forcar, concorrencia);
  } finally {
    await alvo.fechar();
  }
}

async function gerar(
  alvo: NonNullable<Awaited<ReturnType<typeof abrirSemanticaHttp>>>,
  forcar: boolean,
  concorrencia: number
): Promise<boolean> {
  const modo = "http";
  const indice = await carregarIndiceDeScript();
  if (indice.produtos.length === 0) {
    console.error(`${RED}✗${RESET} índice vazio. Rode npm run sync:catalogo antes.`);
    return false;
  }

  console.log(`${BOLD}Tipos e vetores do catálogo — ${config.storeName}${RESET}`);
  console.log(`${GRAY}  modo: ${modo} · ${indice.produtos.length} produto(s) · concorrência: ${concorrencia}${forcar ? " · forçado" : ""}${RESET}\n`);

  const inicio = Date.now();
  let ultimaLinha = "";

  const r = await gerarTiposEVetores(
    indice.produtos,
    {
      tipos: alvo.tipos,
      vetoresProduto: alvo.vetoresProduto,
      vetoresTipo: alvo.vetoresTipo,
      embeddings: clienteEmbeddingsPadrao(config.openaiApiKey),
      rotulos: clienteRotuloPadrao(config.openaiApiKey),
    },
    {
      forcar,
      concorrenciaRotulo: concorrencia,
      onProgresso: (e) => {
        const rotulo =
          e.fase === "rotulo" ? "rotulando tipos" : e.fase === "vetor-produto" ? "vetores dos produtos" : "vetores dos tipos";
        const linha = `  ${rotulo}… ${e.feitos} de ${e.total}`;
        if (process.stdout.isTTY && linha !== ultimaLinha) {
          process.stdout.write(`\r${GRAY}${linha}${RESET}   `);
          ultimaLinha = linha;
        }
      },
    }
  );
  if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(60) + "\r");

  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);

  if (r.travou) {
    const pct = ((r.falhas.length / r.produtos) * 100).toFixed(1);
    console.error(
      `${RED}✗${RESET} ${r.falhas.length} de ${r.produtos} produto(s) (${pct}%) ficaram sem rótulo ou sem vetor — acima do limite de ${MAX_FALHAS * 100}%.`
    );
    console.error(`${RED}  Nada foi gravado: o que já estava no banco continua valendo.${RESET}`);
    for (const f of r.falhas.slice(0, 20)) console.error(`${GRAY}    ${f.id} · ${f.nome}: ${f.erro}${RESET}`);
    if (r.falhas.length > 20) console.error(`${GRAY}    … e mais ${r.falhas.length - 20}${RESET}`);
    return false;
  }

  console.log(`${GREEN}✓${RESET} ${r.produtos} produto(s) · ${r.tiposDistintos} tipo(s) distinto(s)`);
  console.log(`${GRAY}  rótulos novos: ${r.rotulados} · reaproveitados: ${r.reaproveitadosRotulo}${RESET}`);
  console.log(`${GRAY}  vetores novos: ${r.vetorizados} · reaproveitados: ${r.reaproveitadosVetor}${RESET}`);
  console.log(`${GRAY}  gravado no banco (agente.tipos_produto, vetores_produto, vetores_tipo) · ${segundos}s${RESET}`);

  if (r.falhas.length > 0) {
    console.log(`${YELLOW}!${RESET} ${r.falhas.length} produto(s) ficaram de fora (dentro do limite); entram pelo BM25 até a próxima geração:`);
    for (const f of r.falhas.slice(0, 10)) console.log(`${GRAY}    ${f.id} · ${f.nome}: ${f.erro}${RESET}`);
    if (r.falhas.length > 10) console.log(`${GRAY}    … e mais ${r.falhas.length - 10}${RESET}`);
  }
  return true;
}

/** Só quando chamado direto (`npm run gerar:vetores`): importado, nada roda sozinho. */
const chamadoDireto = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/gerarVetores.ts");

if (chamadoDireto) {
  gerarEImprimir()
    .then((ok) => {
      if (!ok) process.exit(1);
    })
    .catch((err) => {
      console.error(`${RED}✗${RESET} geração abortada, o que estava no banco foi preservado: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
