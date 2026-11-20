"use client";

import Link from "next/link";
import { useState } from "react";
import { usePortal } from "@/components/portal/Portal";
import { Button, Card, ErrorNote, PageHeader, inputClass } from "@/components/ui";
import { api, useApi } from "@/lib/client/api";
import type { AssetDetalhe, Etapa } from "@/lib/design";
import type { Message } from "@/lib/types";
import { ROTULO_ETAPA, botoesDaEtapa, seloIa } from "./etapas";
import type { Acao } from "./etapas";

export const PEDIR_ARQUIVO =
  "Para a arte ficar perfeita, você consegue me mandar a logo no arquivo original, em boa resolução? Pode ser PNG, PDF ou SVG.";

type Elemento = { tipo: string; conteudo: string | null; posicao: string; bbox: [number, number, number, number] | null };
type Cor = { hex: string; pantone_aprox: string | null; participacao: number };
type Ficha = {
  peca?: string | null;
  gola?: string | null;
  manga?: string | null;
  tecido_provavel?: string | null;
  observacoes?: string | null;
  elementos?: Elemento[];
  paleta?: Cor[];
  imagem_analisada?: { largura: number; altura: number };
};

interface Detalhe {
  job: {
    id: string;
    lead_id: string;
    cliente: string;
    stage: Etapa;
    ia_status: string;
    designer_id: string | null;
    designer_nome: string | null;
    ficha: Ficha;
    briefing: string | null;
    conversa_com_designer: boolean;
  };
  assets: AssetDetalhe[];
  mensagens: Pick<Message, "id" | "author" | "body" | "sent_at">[];
}

const ROTULO_ACAO: Record<Acao, { texto: string; icone: string; variante?: "outline" | "danger" }> = {
  assumir: { texto: "Assumir", icone: "pan_tool" },
  comecar: { texto: "Começar", icone: "play_arrow" },
  reprocessar: { texto: "Reprocessar IA", icone: "refresh", variante: "outline" },
  enviar_mockup: { texto: "Enviar mockup", icone: "send" },
  ajustes: { texto: "Marcar ajustes", icone: "edit", variante: "outline" },
  cliente_aprovou: { texto: "Cliente aprovou", icone: "verified" },
  devolver: { texto: "Devolver ao atendimento", icone: "undo", variante: "outline" },
  cancelar: { texto: "Cancelar", icone: "close", variante: "danger" },
};

// A bbox fica gravada na ficha, mas não é desenhada: o modelo atual não acerta a posição (dogfooding da entrega 2)
function Original({ asset }: { asset: AssetDetalhe }) {
  if (asset.download) {
    return (
      <a href={asset.url} className="flex items-center gap-2 rounded-xl border border-outline-variant/50 px-3 py-2 text-[13px] text-primary" download>
        <span className="material-symbols-outlined text-[18px]">download</span>
        {asset.nome ?? "arquivo"}
      </a>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl bg-on-surface/[0.04]">
      <img src={asset.url} alt={asset.nome ?? "referência do cliente"} className="block w-full" />
    </div>
  );
}

export function DesignJobView({ id }: { id: string }) {
  const { me, base, isAdmin } = usePortal();
  const { data, error, reload } = useApi<Detalhe>(`/api/design/${id}`, 20_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [legenda, setLegenda] = useState("");
  const [texto, setTexto] = useState("");

  async function run(chave: string, fn: () => Promise<unknown>) {
    setBusy(chave);
    setErro(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <ErrorNote message={error} />;
  const { job, assets, mensagens } = data;
  const ficha = job.ficha ?? {};
  const originais = assets.filter((a) => a.tipo === "ORIGINAL");
  const mockups = assets.filter((a) => a.tipo === "MOCKUP").sort((a, b) => b.versao - a.versao);
  const arteFinal = assets.find((a) => a.tipo === "ARTE_FINAL");
  const souDesigner = me.role === "DESIGNER";
  const acoes = botoesDaEtapa(job.stage, { souDesigner, isAdmin, semDesigner: !job.designer_id, conversaComDesigner: job.conversa_com_designer });
  const podeEscrever = acoes.length > 0 && !acoes.includes("assumir");
  const selo = seloIa(job.stage, job.ia_status);
  const etapa = (para: Etapa) => api(`/api/design/${id}/etapa`, { body: { para } });

  async function subirMockup(file: File) {
    const form = new FormData();
    form.set("arquivo", file);
    const res = await fetch(`/api/design/${id}/mockup`, { method: "POST", body: form });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "Não consegui subir o mockup.");
  }

  const acao: Record<Acao, () => Promise<unknown>> = {
    assumir: () => api(`/api/design/${id}/assumir`, { method: "POST" }),
    comecar: () => etapa("EM_CRIACAO"),
    reprocessar: () => etapa("PROCESSANDO_IA"),
    enviar_mockup: () => {
      if (!mockups[0]) throw new Error("Suba um mockup antes de enviar.");
      return api(`/api/design/${id}/enviar-mockup`, { body: { versao: mockups[0].versao, legenda } }).then(() => setLegenda(""));
    },
    ajustes: () => etapa("AJUSTES"),
    cliente_aprovou: () => api(`/api/design/${id}/confirmar`, { method: "POST" }),
    devolver: () => api(`/api/design/${id}/devolver`, { method: "POST" }),
    cancelar: () => (window.confirm("Cancelar este job de design?") ? etapa("CANCELADO") : Promise.resolve()),
  };
  const enviarTexto = (t: string) => api(`/api/leads/${job.lead_id}/enviar`, { body: { text: t } });

  return (
    <div className="space-y-6">
      <PageHeader
        title={job.cliente}
        subtitle={`${ROTULO_ETAPA[job.stage]}${job.designer_nome ? ` · ${job.designer_nome}` : " · sem designer"}`}
        actions={
          <Link href={`${base}/design`} className="text-[13px] font-semibold text-primary">
            Voltar ao quadro
          </Link>
        }
      />
      <ErrorNote message={erro ?? error} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-4 p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-label-caps text-[11px] text-primary">Referências do cliente</h3>
            {selo && <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${selo.classe}`}>{selo.texto}</span>}
          </div>
          {originais.length === 0 && <p className="text-[13px] text-on-surface-variant">Sem imagem. Peça o arquivo ao cliente.</p>}
          {originais.map((a) => (
            <Original key={a.id} asset={a} />
          ))}
          {(ficha.peca || ficha.gola || ficha.manga || ficha.tecido_provavel) && (
            <dl className="grid grid-cols-2 gap-2 text-[13px]">
              {(["peca", "gola", "manga", "tecido_provavel"] as const).map((k) =>
                ficha[k] ? (
                  <div key={k}>
                    <dt className="text-[11px] text-on-surface-variant">{k === "tecido_provavel" ? "tecido provável" : k === "peca" ? "peça" : k}</dt>
                    <dd className="text-on-surface">{ficha[k]}</dd>
                  </div>
                ) : null
              )}
            </dl>
          )}
          {ficha.observacoes && <p className="text-[12px] text-on-surface-variant">{ficha.observacoes}</p>}
          {job.briefing && (
            <div>
              <h4 className="mb-1 text-[11px] text-on-surface-variant">Briefing</h4>
              <p className="whitespace-pre-line text-[13px] text-on-surface">{job.briefing}</p>
            </div>
          )}
        </Card>

        <Card className="space-y-4 p-4">
          <h3 className="font-label-caps text-[11px] text-primary">Kit de partida</h3>
          {ficha.elementos?.length ? (
            <ul className="space-y-1 text-[13px]">
              {ficha.elementos.map((e, i) => (
                <li key={i}>
                  <span className="font-semibold">{e.tipo}</span>
                  {e.conteudo ? ` "${e.conteudo}"` : ""} · {e.posicao}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-on-surface-variant">
              {job.stage === "PROCESSANDO_IA" ? "Aguardando o kit da IA." : job.ia_status === "SEM_IMAGEM" ? "Sem imagem para analisar." : "Sem elementos."}
            </p>
          )}
          {ficha.paleta?.length ? (
            <div className="space-y-1">
              <p className="text-[11px] text-on-surface-variant">Paleta (Pantone aproximado)</p>
              {ficha.paleta.map((c) => (
                <div key={c.hex} className="flex items-center gap-2 text-[13px]">
                  <span className="h-5 w-5 rounded border border-outline-variant/50" style={{ background: c.hex }} />
                  <span className="font-mono">{c.hex}</span>
                  {c.pantone_aprox && <span className="text-on-surface-variant">~Pantone {c.pantone_aprox}</span>}
                  <span className="ml-auto text-on-surface-variant">{Math.round(c.participacao * 100)}%</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="space-y-2 border-t border-outline-variant/20 pt-3">
            <h4 className="text-[11px] text-on-surface-variant">Mockup</h4>
            {arteFinal && <p className="text-[13px] font-semibold text-green-700">Arte final aprovada: versão {arteFinal.versao}</p>}
            {mockups.map((m) => (
              <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-[13px] text-primary">
                <img src={m.url} alt={`mockup v${m.versao}`} className="h-10 w-10 rounded object-cover" />v{m.versao}
              </a>
            ))}
            {podeEscrever && ["EM_CRIACAO", "AJUSTES", "AGUARDANDO_CLIENTE"].includes(job.stage) && (
              <label className="block">
                <span className="mb-1 block text-[12px] text-on-surface-variant">Nova versão (PNG, JPEG ou WEBP)</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={busy !== null}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void run("mockup", () => subirMockup(f));
                  }}
                  className="text-[13px]"
                />
              </label>
            )}
            {acoes.includes("enviar_mockup") && (
              <input className={inputClass} placeholder="Legenda do mockup (opcional)" value={legenda} maxLength={1000} onChange={(e) => setLegenda(e.target.value)} />
            )}
          </div>
        </Card>

        <Card className="flex flex-col gap-3 p-4">
          <h3 className="font-label-caps text-[11px] text-primary">Conversa</h3>
          <div className="thin-scroll max-h-[360px] space-y-2 overflow-y-auto">
            {mensagens.map((m) => (
              <p
                key={m.id}
                className={`rounded-xl px-3 py-2 text-[13px] ${m.author === "CLIENTE" ? "bg-on-surface/[0.05]" : "ml-6 bg-primary/10"}`}
              >
                {m.body}
              </p>
            ))}
          </div>
          {podeEscrever && (
            <div className="space-y-2">
              <textarea className={inputClass} rows={2} placeholder="Falar com o cliente" value={texto} maxLength={4000} onChange={(e) => setTexto(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                <Button icon="send" loading={busy === "texto"} disabled={!texto.trim()} onClick={() => run("texto", () => enviarTexto(texto).then(() => setTexto("")))}>
                  Enviar
                </Button>
                <Button variant="outline" icon="upload_file" loading={busy === "alta"} onClick={() => run("alta", () => enviarTexto(PEDIR_ARQUIVO))}>
                  Pedir arquivo em alta
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2 border-t border-outline-variant/20 pt-3">
            {acoes.map((a) => (
              <Button key={a} variant={ROTULO_ACAO[a].variante ?? "primary"} icon={ROTULO_ACAO[a].icone} loading={busy === a} onClick={() => run(a, acao[a])}>
                {ROTULO_ACAO[a].texto}
              </Button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
