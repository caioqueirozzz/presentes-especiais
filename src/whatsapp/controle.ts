import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import { z } from "zod";
import type { ArquivoRecebido } from "../agent/state.js";
import { encaminharParaDesign } from "../integrations/crm/design.js";
import type { LogPonte } from "./log.js";
import { validarConfigLia, type ArmazemModoLia } from "./modoLia.js";
import type { Ponte } from "./ponte.js";
import type { CanalWwebjs } from "./sessao.js";

/*
 * Servidor de controle da ponte, chamado pelo CRM (nunca exposto à internet: escuta só em 127.0.0.1
 * por padrão e exige o segredo compartilhado CRM_INTEGRATION_SECRET).
 *
 *  GET  /status             estado da conexão e o QR (texto) quando houver
 *  POST /nova-vinculacao    desvincula o aparelho e gera um QR novo
 *  POST /enviar             { telefone, texto } → { id } (vale como atendente: a IA pausa na conversa)
 *  POST /devolver           { telefone, nota?, consumidas? } → devolve a conversa à IA; consumidas não chegam a ela
 *  POST /enviar-midia       { telefone, url, legenda } → { id } (foto do mockup; vale como atendente, igual ao /enviar)
 *  POST /encaminhar-design  { telefone, requested_by? } → { jobId, imagens } (abre o job com os arquivos da conversa)
 *  GET  /lia                modo da Lia (ligada | teste | desligada) e números de teste
 *  POST /lia                { modo, numerosTeste } → grava e passa a valer na hora
 */

const LIMITE_CORPO = 64 * 1024;

function autorizado(req: IncomingMessage, segredo: string): boolean {
  const dado = req.headers["x-ponte-secret"];
  if (typeof dado !== "string" || segredo.length < 16) return false;
  const a = Buffer.from(dado);
  const b = Buffer.from(segredo);
  return a.length === b.length && timingSafeEqual(a, b);
}

function responder(res: ServerResponse, status: number, corpo: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(corpo));
}

async function lerJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let tamanho = 0;
  const partes: Buffer[] = [];
  for await (const parte of req) {
    tamanho += (parte as Buffer).length;
    if (tamanho > LIMITE_CORPO) throw new Error("corpo grande demais");
    partes.push(parte as Buffer);
  }
  const texto = Buffer.concat(partes).toString("utf8");
  const json = texto ? JSON.parse(texto) : {};
  return json && typeof json === "object" && !Array.isArray(json) ? json : {};
}

const docConversa = z.object({
  estado: z.object({
    arquivosRecebidos: z.array(z.object({ nome: z.string(), caminho: z.string(), mime: z.string(), bytes: z.number() })).optional(),
  }),
});

/** Arquivos recebidos no documento da conversa gravado pelo agente; documento ausente ou estranho dá lista vazia. */
export function arquivosDaConversa(doc: unknown): ArquivoRecebido[] {
  const lido = docConversa.safeParse(doc);
  return lido.success ? (lido.data.estado.arquivosRecebidos ?? []) : [];
}

const urlAceita =(u: string) => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u);

export interface OpcoesControle {
  porta: number;
  host?: string;
  segredo: string;
  canal: CanalWwebjs;
  ponte: Ponte;
  lia: ArmazemModoLia;
  log: LogPonte;
  /** Arquivos que o cliente mandou nesta conversa (estado gravado pelo agente). */
  lerArquivos: (telefone: string) => Promise<ArquivoRecebido[]>;
}

export function tratadorControle(opcoes: OpcoesControle): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { canal, ponte, lia, segredo, log } = opcoes;
  return async (req, res) => {
    if (!autorizado(req, segredo)) return responder(res, 401, { erro: "não autorizado" });
    try {
      if (req.method === "GET" && req.url === "/status") {
        return responder(res, 200, canal.situacao());
      }
      if (req.method === "GET" && req.url === "/lia") {
        return responder(res, 200, await lia.ler());
      }
      if (req.method === "POST" && req.url === "/lia") {
        const valido = validarConfigLia(await lerJson(req));
        if (typeof valido === "string") return responder(res, 400, { erro: valido });
        const salvo = await lia.salvar(valido);
        ponte.definirModoLia(salvo);
        log({ type: "modo_lia", modo: salvo.modo, numerosTeste: salvo.numerosTeste.length });
        return responder(res, 200, salvo);
      }
      if (req.method === "POST" && req.url === "/nova-vinculacao") {
        void canal.novaVinculacao();
        return responder(res, 202, { ok: true });
      }
      if (req.method === "POST" && req.url === "/enviar") {
        const corpo = await lerJson(req);
        const telefone = typeof corpo.telefone === "string" ? corpo.telefone.replace(/\D/g, "") : "";
        const texto = typeof corpo.texto === "string" ? corpo.texto.trim().slice(0, 4_000) : "";
        if (telefone.length < 10 || !texto) return responder(res, 400, { erro: "telefone e texto são obrigatórios" });
        if (canal.situacao().estado !== "CONECTADO") return responder(res, 409, { erro: "O WhatsApp não está conectado." });
        const id = await canal.enviarTexto(telefone, texto);
        return responder(res, 200, { id });
      }
      if (req.method === "POST" && req.url === "/enviar-midia") {
        const corpo = await lerJson(req);
        const telefone = typeof corpo.telefone === "string" ? corpo.telefone.replace(/\D/g, "") : "";
        const url = typeof corpo.url === "string" ? corpo.url : "";
        const legenda = typeof corpo.legenda === "string" ? corpo.legenda : "";
        if (telefone.length < 10 || !urlAceita(url) || legenda.length > 1_000) {
          return responder(res, 400, { erro: "telefone, url (https ou local) e legenda de até 1.000 caracteres" });
        }
        if (canal.situacao().estado !== "CONECTADO") return responder(res, 409, { erro: "O WhatsApp não está conectado." });
        // Fora do registro de saída da Lia de propósito: o eco chega como atendente e a Lia pausa
        const id = await canal.enviarImagemParaTelefone(telefone, url, legenda);
        return responder(res, 200, { id });
      }
      if (req.method === "POST" && req.url === "/encaminhar-design") {
        const corpo = await lerJson(req);
        const telefone = typeof corpo.telefone === "string" ? corpo.telefone.replace(/\D/g, "") : "";
        if (telefone.length < 10) return responder(res, 400, { erro: "telefone obrigatório" });
        const requestedBy = typeof corpo.requested_by === "string" ? corpo.requested_by.slice(0, 64) : undefined;
        try {
          const r = await encaminharParaDesign({ telefone, origem: "VENDEDOR", requestedBy, arquivos: await opcoes.lerArquivos(telefone) });
          return responder(res, 200, r);
        } catch (err) {
          log({ type: "encaminhar_design_falhou", erro: String(err) });
          return responder(res, 502, { erro: "O CRM não recebeu o job de design." });
        }
      }
      if (req.method === "POST" && req.url === "/devolver") {
        const corpo = await lerJson(req);
        const telefone = typeof corpo.telefone === "string" ? corpo.telefone.replace(/\D/g, "") : "";
        if (telefone.length < 10) return responder(res, 400, { erro: "telefone obrigatório" });
        const consumidas = Array.isArray(corpo.consumidas)
          ? corpo.consumidas.filter((id): id is string => typeof id === "string" && id.length <= 200).slice(0, 20)
          : [];
        await ponte.devolverParaIa(telefone, typeof corpo.nota === "string" ? corpo.nota.slice(0, 500) : undefined, consumidas);
        return responder(res, 200, { ok: true });
      }
      return responder(res, 404, { erro: "rota desconhecida" });
    } catch (err) {
      log({ type: "controle_erro", url: req.url ?? "", erro: String(err) });
      return responder(res, 500, { erro: err instanceof Error ? err.message : "erro" });
    }
  };
}

export function iniciarControle(opcoes: OpcoesControle): void {
  const servidor = createServer(tratadorControle(opcoes));
  servidor.listen(opcoes.porta, opcoes.host ?? "127.0.0.1", () => {
    console.log(`Controle da ponte em http://${opcoes.host ?? "127.0.0.1"}:${opcoes.porta} (para o CRM)`);
  });
}
