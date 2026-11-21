"use client";

import Link from "next/link";
import { usePortal } from "@/components/portal/Portal";
import { EmptyState, ErrorNote, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/client/api";
import type { CardJob } from "@/lib/design";
import { COLUNAS, seloIa } from "./etapas";

/** Quadro do designer. Sem arrastar: cada etapa muda por um botão do detalhe, porque tem efeito colateral. */
export function DesignBoard() {
  const { base } = usePortal();
  const { data, error, loading } = useApi<{ jobs: CardJob[] }>("/api/design", 30_000);
  const jobs = data?.jobs ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Design" subtitle="Jobs de arte e mockup" />
      <ErrorNote message={error} />
      {!loading && jobs.length === 0 && !error ? (
        <EmptyState icon="palette" title="Nenhum job de design" text="Quando um vendedor ou a Lia mandar uma arte para o design, ela aparece aqui." />
      ) : (
        <div className="thin-scroll -mx-4 overflow-x-auto px-4 pb-4 md:-mx-10 md:px-10">
          <div className="flex min-w-max gap-4">
            {COLUNAS.map((col) => {
              const itens = jobs.filter((j) => col.etapas.includes(j.stage));
              return (
                <section key={col.key} className="flex w-[280px] shrink-0 flex-col rounded-3xl bg-on-surface/[0.03] p-3">
                  <header className={`mb-3 border-t-2 px-1 pt-3 ${col.border}`}>
                    <div className="flex items-center justify-between">
                      <h3 className="font-label-caps text-[11px] text-primary">{col.label}</h3>
                      <span className="rounded-full bg-on-surface/[0.07] px-2 py-0.5 text-[11px] font-bold text-primary">{itens.length}</span>
                    </div>
                  </header>
                  <div className="thin-scroll flex max-h-[calc(100vh-300px)] min-h-[160px] flex-col gap-3 overflow-y-auto pb-1">
                    {itens.map((j) => {
                      const selo = seloIa(j.stage, j.ia_status);
                      return (
                        <Link key={j.id} href={`${base}/design/${j.id}`} className="premium-card block rounded-2xl p-3">
                          {j.miniatura && (
                            <img src={j.miniatura} alt="" className="mb-2 h-28 w-full rounded-xl bg-on-surface/[0.04] object-cover" />
                          )}
                          <p className="line-clamp-1 text-[14px] font-semibold text-on-surface">{j.cliente}</p>
                          {j.peca && <p className="line-clamp-1 text-[12px] text-on-surface-variant">{j.peca}</p>}
                          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                            {selo && <span className={`rounded-full px-2 py-0.5 font-semibold ${selo.classe}`}>{selo.texto}</span>}
                            {j.prioridade === "alta" && <span className="rounded-full bg-red-50 px-2 py-0.5 font-semibold text-red-700">alta</span>}
                            {j.prazo && (
                              <span className="rounded-full bg-on-surface/[0.05] px-2 py-0.5 text-on-surface-variant">
                                {new Date(j.prazo).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
                              </span>
                            )}
                            {!j.designer_id && <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-800">sem designer</span>}
                          </div>
                        </Link>
                      );
                    })}
                    {itens.length === 0 && <p className="py-6 text-center text-[12px] text-on-surface-variant/60">Vazio</p>}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
