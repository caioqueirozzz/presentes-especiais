import type { ResultadoSyncCatalogo } from "./indice.js";
import type { ResultadoGeracao } from "./geracao.js";
import { IndiceMudouError } from "./indicePg.js";

export interface DependenciasCiclo<I> {
  sincronizar(): Promise<ResultadoSyncCatalogo>;
  /** Relê o catálogo para a busca e devolve o que leu. */
  recarregar(): Promise<I>;
  /** Assinatura barata do que está no banco; ausente fora do Postgres. */
  assinatura?(): Promise<string>;
  /** Geração incremental de tipos e vetores; ausente sem OPENAI_API_KEY ou fora do http. */
  gerar?(indice: I): Promise<ResultadoGeracao>;
  log(linha: string): void;
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Um ciclo por vez: sync, releitura e geração de vetores. O disparo que chega com outro em curso não faz nada,
 * e a conferência dos 5 min também espera, para não reler o catálogo no meio do sync.
 */
export function criarCicloSync<I>(deps: DependenciasCiclo<I>, gravacaoInicial = ""): { executar(): Promise<void>; conferirGravacaoExterna(): Promise<void> } {
  let emCurso = false;
  let gravacaoVista = gravacaoInicial;

  async function reler(): Promise<I | null> {
    try {
      // Assinatura antes da releitura: gravação no meio faz a próxima conferência reler de novo, nunca perde.
      const g = (await deps.assinatura?.()) ?? "";
      const indice = await deps.recarregar();
      gravacaoVista = g;
      return indice;
    } catch (err) {
      deps.log(`Releitura do catálogo falhou; o índice em uso continua: ${msg(err)}`);
      return null;
    }
  }

  return {
    async executar() {
      if (emCurso) return;
      emCurso = true;
      try {
        let r: ResultadoSyncCatalogo;
        try {
          r = await deps.sincronizar();
        } catch (err) {
          if (err instanceof IndiceMudouError) {
            deps.log("Sync do catálogo: índice mudou por fora; tenta no próximo ciclo.");
            await reler();
          } else {
            deps.log(`Sync do catálogo falhou; o índice anterior continua valendo: ${msg(err)}`);
          }
          return;
        }
        deps.log(`Catálogo sincronizado: ${r.ativos} ativos, ${r.novos} novos, ${r.removidos} removidos${r.completo ? "" : " (incompleto)"}`);
        const indice = await reler();
        if (!deps.gerar || !indice) return;
        try {
          const g = await deps.gerar(indice);
          if (g.travou) deps.log(`Geração de vetores travada (${g.falhas.length} de ${g.produtos} sem rótulo ou vetor); a busca segue com os anteriores.`);
        } catch (err) {
          deps.log(`Geração de vetores falhou; a busca segue com os anteriores: ${msg(err)}`);
        }
      } finally {
        emCurso = false;
      }
    },

    /** Quem grava por fora (sync:precos noturno) não avisa a API: ela confere o banco a cada 5 min. */
    async conferirGravacaoExterna() {
      if (emCurso || !deps.assinatura) return;
      try {
        if ((await deps.assinatura()) !== gravacaoVista) await reler();
      } catch (err) {
        deps.log(`Releitura do catálogo falhou; o índice em uso continua: ${msg(err)}`);
      }
    },
  };
}
