/**
 * Preço de venda do site no índice (Fase 0).
 *
 *   npm run sync:precos                    # noturno: reconsulta o site para cada grupo de cores
 *   npm run sync:precos -- --concorrencia 1
 *
 * Só fala com a rota da vitrine, não com a API oficial. Mais de 5% dos grupos com falha: não grava nada e sai com 1.
 */
import "dotenv/config";
import { config } from "../src/config.js";
import { abrirCatalogoHttp } from "../src/catalogo/abrir.js";
import { FRACAO_MAXIMA_DE_FALHAS, sincronizarPrecos } from "../src/catalogo/syncPrecos.js";
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
  const concorrencia = numero("concorrencia", 1);
  const { store, fechar } = await abrirCatalogoHttp("sync:precos");
  const inicio = Date.now();
  const onProgresso = (feitos: number, total: number) => {
    if (feitos % 200 === 0 || feitos === total) console.log(`  ${feitos}/${total} grupos`);
  };

  let r;
  try {
    r = await sincronizarPrecos(store, consultar, { concorrencia, onProgresso });
  } finally {
    await fechar();
  }
  if (r.grupos === 0) {
    console.error("Índice vazio: rode npm run sync:catalogo antes.");
    process.exit(1);
  }

  console.log(`${r.atualizados}/${r.grupos} grupos atualizados em ${Math.round((Date.now() - inicio) / 1000)}s; ${r.semPreco} sem preço no site (todas as cores 404); ${r.falhas.length} falha(s).`);
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
