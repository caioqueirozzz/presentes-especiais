import { describe, it, expect, afterEach } from "vitest";
import type { Banco } from "../src/db/banco.js";
import { bancoDeTeste } from "./helpers/bancoDeTeste.js";
import { executarPlano, planejarCliente, planejarPorIdade, tirarTelefonesDoEstadoPonte } from "../src/operacao/retencaoBanco.js";
import { estadoVazio } from "../src/whatsapp/estadoPonte.js";

const DIA = 86_400_000;
const AGORA = Date.parse("2026-11-10T12:00:00Z");
const VELHO = "5583900000001";
const NOVO = "5583900000002";

async function semear(banco: Banco): Promise<void> {
  const doc = (tel: string, id: string) => JSON.stringify({ versao: 1, estado: { telefone: tel, conversaId: id } });
  await banco.query("INSERT INTO agente.conversas (telefone, doc, atualizado_em) VALUES ($1, $2::jsonb, $3)", [VELHO, doc(VELHO, "c-velho"), new Date(AGORA - 100 * DIA)]);
  await banco.query("INSERT INTO agente.conversas (telefone, doc, atualizado_em) VALUES ($1, $2::jsonb, $3)", [NOVO, doc(NOVO, "c-novo"), new Date(AGORA - 1 * DIA)]);
  await banco.query("INSERT INTO agente.lacunas (conversa_id, pergunta, registrado_em) VALUES ('c-velho', 'p', $1), ('c-novo', 'p', $2)", [new Date(AGORA - 100 * DIA), new Date(AGORA - 1 * DIA)]);
  const corrompida = "INSERT INTO agente.conversas_corrompidas (telefone, doc, erro, separado_em) VALUES ($1, '{}', 'x', $2)";
  await banco.query(corrompida, [VELHO, new Date(AGORA - 100 * DIA)]);
  await banco.query(corrompida, [NOVO, new Date(AGORA - 1 * DIA)]);
  const ponte = { ...estadoVazio(), modos: { [VELHO]: "humano", [NOVO]: "ia" }, eventosPendentes: [{ telefone: VELHO }] };
  await banco.query("INSERT INTO agente.estado_ponte (id, doc) VALUES (1, $1::jsonb)", [JSON.stringify(ponte)]);
}

describe("retenção no banco", () => {
  let banco: Banco | undefined;
  afterEach(async () => {
    await banco?.fechar();
    banco = undefined;
  });

  it("por idade: lista sem apagar", async () => {
    banco = await bancoDeTeste();
    await semear(banco);
    const plano = await planejarPorIdade(banco, 90, AGORA);
    expect(plano).toEqual({ telefones: [VELHO], conversaIds: ["c-velho"], lacunas: 1, corrompidas: 1, registrosPonte: 2 });
    expect(await banco.query("SELECT telefone FROM agente.conversas")).toHaveLength(2);
  });

  it("por idade: executar apaga só o velho", async () => {
    banco = await bancoDeTeste();
    await semear(banco);
    await executarPlano(banco, await planejarPorIdade(banco, 90, AGORA), { dias: 90, agora: AGORA });
    expect((await banco.query<{ telefone: string }>("SELECT telefone FROM agente.conversas")).map((r) => r.telefone)).toEqual([NOVO]);
    expect(await banco.query("SELECT 1 FROM agente.lacunas")).toHaveLength(1);
    expect((await banco.query<{ telefone: string }>("SELECT telefone FROM agente.conversas_corrompidas")).map((r) => r.telefone)).toEqual([NOVO]);
    const [ponte] = await banco.query<{ doc: { modos: Record<string, string>; eventosPendentes: unknown[] } }>("SELECT doc FROM agente.estado_ponte");
    expect(Object.keys(ponte.doc.modos)).toEqual([NOVO]);
    expect(ponte.doc.eventosPendentes).toEqual([]);
  });

  it("por cliente: sai tudo dele, mesmo ativo", async () => {
    banco = await bancoDeTeste();
    await semear(banco);
    const plano = await planejarCliente(banco, NOVO);
    expect(plano).toEqual({ telefones: [NOVO], conversaIds: ["c-novo"], lacunas: 1, corrompidas: 1, registrosPonte: 1, telefoneCliente: NOVO });
    await executarPlano(banco, plano, null);
    expect((await banco.query<{ telefone: string }>("SELECT telefone FROM agente.conversas")).map((r) => r.telefone)).toEqual([VELHO]);
    expect((await banco.query<{ telefone: string }>("SELECT telefone FROM agente.conversas_corrompidas")).map((r) => r.telefone)).toEqual([VELHO]);
  });

  it("prazo menor que 1 dia é recusado", async () => {
    banco = await bancoDeTeste();
    await expect(planejarPorIdade(banco, 0, AGORA)).rejects.toThrow(/pelo menos 1 dia/);
  });

  it("tirarTelefonesDoEstadoPonte conta o que saiu", () => {
    const e = { ...estadoVazio(), modos: { [VELHO]: "humano" as const }, entregasParciais: { [VELHO]: { ids: [], partes: [] } } };
    expect(tirarTelefonesDoEstadoPonte(e, [VELHO]).registros).toBe(2);
  });

  it("ponte ilegível não é sobrescrita pela retenção por idade", async () => {
    banco = await bancoDeTeste();
    await semear(banco);
    await banco.query("UPDATE agente.estado_ponte SET doc = '{\"lixo\":true}'::jsonb WHERE id = 1");
    await executarPlano(banco, await planejarPorIdade(banco, 90, AGORA), { dias: 90, agora: AGORA });
    expect(await banco.query("SELECT 1 FROM agente.conversas WHERE telefone = $1", [VELHO])).toHaveLength(0);
    const [ponte] = await banco.query<{ doc: unknown }>("SELECT doc FROM agente.estado_ponte");
    expect(ponte.doc).toEqual({ lixo: true });
  });

  it("conversa que voltou a andar depois do plano fica, e a ponte dela também", async () => {
    banco = await bancoDeTeste();
    await semear(banco);
    const plano = await planejarPorIdade(banco, 90, AGORA);
    await banco.query("UPDATE agente.conversas SET atualizado_em = $1 WHERE telefone = $2", [new Date(AGORA), VELHO]);
    await executarPlano(banco, plano, { dias: 90, agora: AGORA });
    expect(await banco.query("SELECT 1 FROM agente.conversas WHERE telefone = $1", [VELHO])).toHaveLength(1);
    const [ponte] = await banco.query<{ doc: { modos: Record<string, string> } }>("SELECT doc FROM agente.estado_ponte");
    expect(Object.keys(ponte.doc.modos).sort()).toEqual([VELHO, NOVO].sort());
  });

  it("cliente sem nada: plano zerado", async () => {
    banco = await bancoDeTeste();
    await semear(banco);
    expect(await planejarCliente(banco, "5521900000000")).toEqual({ telefones: [], conversaIds: [], lacunas: 0, corrompidas: 0, registrosPonte: 0, telefoneCliente: "5521900000000" });
  });

  it("cliente só na ponte: conta, executa e não toca nos outros", async () => {
    banco = await bancoDeTeste();
    await semear(banco);
    await banco.query("DELETE FROM agente.conversas WHERE telefone = $1", [VELHO]);
    const plano = await planejarCliente(banco, VELHO);
    expect(plano.telefones).toEqual([]);
    expect(plano.registrosPonte).toBe(2);
    await executarPlano(banco, plano, null);
    const [ponte] = await banco.query<{ doc: { modos: Record<string, string>; eventosPendentes: unknown[] } }>("SELECT doc FROM agente.estado_ponte");
    expect(Object.keys(ponte.doc.modos)).toEqual([NOVO]);
    expect(ponte.doc.eventosPendentes).toEqual([]);
  });
});
