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
