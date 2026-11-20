import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { temErro, verificarAmbiente, type FatosAmbiente } from "../src/operacao/verificacaoAmbiente.js";
import { exigirAmbiente } from "../src/operacao/exigirAmbiente.js";
import { apagar, selecionarCliente, selecionarParaLimpeza } from "../src/operacao/retencao.js";
import { formatarRelatorio, resumirLogs } from "../src/operacao/relatorio.js";

const FATOS_OK: FatosAmbiente = {
  temArquivoEnv: true,
  produtosNoIndice: 6527,
  itensAprovados: 12,
  suspenso: false,
  ferramentasDesligadasRuntime: [],
};

const ENV_PILOTO = {
  OPENAI_API_KEY: "sk-proj-abc123",
  LLM_MODEL: "gpt-6-luna",
  LLM_REASONING: "none",
  BRINDEME_MODE: "http",
  BRINDEME_BASE_URL: "https://api.loja.com.br",
  BRINDEME_TOKEN: "tok",
  WHATSAPP_LIBERADOS: "5583999990000",
  CRM_URL: "https://crm.loja.com.br",
  CRM_INTEGRATION_SECRET: "0123456789abcdef",
};

describe("verificar:env", () => {
  it("sem BRINDEME_MODE: erro em produção, aviso em desenvolvimento", () => {
    const { BRINDEME_MODE: _, ...semModo } = ENV_PILOTO;
    expect(verificarAmbiente(semModo, FATOS_OK, { producao: true }).find((a) => a.item === "BRINDEME_MODE")?.gravidade).toBe("erro");
    expect(verificarAmbiente(semModo, FATOS_OK, { producao: false }).find((a) => a.item === "BRINDEME_MODE")?.gravidade).toBe("aviso");
  });

  it("CRM desligado sem CRM=desligado: erro em produção; com CRM=desligado, só aviso", () => {
    const semCrm = { ...ENV_PILOTO, CRM_URL: "", CRM_INTEGRATION_SECRET: "" };
    expect(verificarAmbiente(semCrm, FATOS_OK, { producao: true }).find((a) => a.item === "CRM")?.gravidade).toBe("erro");
    expect(verificarAmbiente({ ...semCrm, CRM_INTEGRATION_SECRET: "curto", CRM_URL: "https://crm" }, FATOS_OK, { producao: true }).find((a) => a.item === "CRM")?.gravidade).toBe("erro");
    expect(verificarAmbiente({ ...semCrm, CRM: "desligado" }, FATOS_OK, { producao: true }).find((a) => a.item === "CRM")?.gravidade).toBe("aviso");
    expect(verificarAmbiente(semCrm, FATOS_OK, { producao: false }).find((a) => a.item === "CRM")?.gravidade).toBe("aviso");
  });

  it("exigirAmbiente: produção é o padrão e sai com 1; AMBIENTE=dev deixa passar; a ponte só olha o CRM", () => {
    const saida = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    const avisoConsole = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      exigirAmbiente("ponte", { CRM_URL: "" });
      expect(saida).toHaveBeenCalledWith(1);
      saida.mockClear();
      exigirAmbiente("ponte", { CRM_URL: "", AMBIENTE: "dev" });
      exigirAmbiente("ponte", { CRM: "desligado" });
      exigirAmbiente("ponte", { CRM_URL: "https://crm.loja.com.br", CRM_INTEGRATION_SECRET: "0123456789abcdef" });
      expect(saida).not.toHaveBeenCalled();
      exigirAmbiente("agente", { CRM: "desligado" });
      expect(saida).toHaveBeenCalledWith(1);
    } finally {
      saida.mockRestore();
      erro.mockRestore();
      avisoConsole.mockRestore();
    }
  });

  it("piloto bem configurado: sem erro e sem aviso", () => {
    const a = verificarAmbiente(ENV_PILOTO, FATOS_OK, { producao: true });
    expect(a.filter((x) => x.gravidade !== "ok")).toEqual([]);
  });

  it("chave de exemplo, modelo vazio e mock em produção são ERRO", () => {
    const a = verificarAmbiente({ ...ENV_PILOTO, OPENAI_API_KEY: "sk-...", LLM_MODEL: "", BRINDEME_MODE: "mock" }, FATOS_OK, { producao: true });
    const erros = a.filter((x) => x.gravidade === "erro").map((x) => x.item);
    expect(erros).toEqual(expect.arrayContaining(["OPENAI_API_KEY", "LLM_MODEL", "BRINDEME_MODE"]));
    expect(temErro(a)).toBe(true);
  });

  it("em desenvolvimento, mock e rascunho só avisam", () => {
    const a = verificarAmbiente({ ...ENV_PILOTO, BRINDEME_MODE: "mock", KB_INCLUIR_RASCUNHOS: "true" }, FATOS_OK, { producao: false });
    expect(temErro(a)).toBe(false);
    expect(a.filter((x) => x.gravidade === "aviso").map((x) => x.item)).toEqual(expect.arrayContaining(["BRINDEME_MODE", "KB_INCLUIR_RASCUNHOS"]));
  });

  it("http sem https, sem token, ferramenta com nome errado e prazos invertidos são ERRO", () => {
    const a = verificarAmbiente(
      { ...ENV_PILOTO, BRINDEME_BASE_URL: "http://api.loja.com.br", BRINDEME_TOKEN: "", FERRAMENTAS_DESLIGADAS: "criar_orcamentos", TURNO_TETO_MS: "130000" },
      FATOS_OK,
      { producao: true }
    );
    const erros = a.filter((x) => x.gravidade === "erro").map((x) => x.item);
    expect(erros).toEqual(expect.arrayContaining(["BRINDEME_BASE_URL", "BRINDEME_TOKEN", "FERRAMENTAS_DESLIGADAS", "TURNO_TETO_MS"]));
  });

  it("avisa base sem item aprovado, número liberado vazio, reasoning low e agente suspenso", () => {
    const a = verificarAmbiente(
      { ...ENV_PILOTO, WHATSAPP_LIBERADOS: "", LLM_REASONING: "low" },
      { ...FATOS_OK, itensAprovados: 0, suspenso: true },
      { producao: true }
    );
    expect(a.filter((x) => x.gravidade === "aviso").map((x) => x.item)).toEqual(
      expect.arrayContaining(["base de conhecimento", "WHATSAPP_LIBERADOS", "LLM_REASONING", "estado-sistema"])
    );
  });

  it("LLM_REASONING preenchido com modelo da família gpt-4 é ERRO; vazio passa", () => {
    const comNone = verificarAmbiente({ ...ENV_PILOTO, LLM_MODEL: "gpt-4o-mini", LLM_REASONING: "none" }, FATOS_OK, { producao: false });
    expect(comNone.filter((x) => x.gravidade === "erro").map((x) => x.item)).toContain("LLM_REASONING");
    const vazio = verificarAmbiente({ ...ENV_PILOTO, LLM_MODEL: "gpt-4o-mini", LLM_REASONING: "" }, FATOS_OK, { producao: true });
    expect(vazio.filter((x) => x.item === "LLM_REASONING")).toEqual([]);
  });

  it("nunca mostra o valor da chave nem do token", () => {
    const texto = JSON.stringify(verificarAmbiente(ENV_PILOTO, FATOS_OK, { producao: true }));
    expect(texto).not.toContain("sk-proj-abc123");
    expect(texto).not.toContain('"tok"');
  });
});

describe("limpar:dados (retenção de arquivos)", () => {
  const DIA = 86_400_000;
  const agora = Date.parse("2026-10-19T12:00:00Z");
  const VELHO = "5583999990000";
  const ATIVO = "5511988887777";
  const vivas = new Set([ATIVO]);

  function montar() {
    const raiz = mkdtempSync(join(tmpdir(), "retencao-"));
    const pastas = { artes: join(raiz, "artes"), logs: join(raiz, "logs") };
    for (const p of Object.values(pastas)) mkdirSync(p);
    const arquivo = (caminho: string, diasAtras: number) => {
      writeFileSync(caminho, "x");
      const t = new Date(agora - diasAtras * DIA);
      utimesSync(caminho, t, t);
    };
    mkdirSync(join(pastas.artes, VELHO));
    arquivo(join(pastas.artes, VELHO, "logo.png"), 120);
    mkdirSync(join(pastas.artes, ATIVO));
    arquivo(join(pastas.artes, ATIVO, "velha.png"), 200); // cliente ativo: fica
    arquivo(join(pastas.logs, "conv-antiga.jsonl"), 100);
    arquivo(join(pastas.logs, "conv-nova.jsonl"), 1);
    arquivo(join(pastas.logs, "api.jsonl"), 400);
    return pastas;
  }

  it("seleciona só o que passou do prazo; artes de cliente ativo e api.jsonl ficam", () => {
    const alvos = selecionarParaLimpeza(montar(), 90, agora, vivas);
    expect(alvos.map((a) => `${a.tipo}:${a.caminho.split(/[\\/]/).slice(-1)[0]}`).sort()).toEqual(
      [`artes:${VELHO}`, "log:conv-antiga.jsonl"].sort()
    );
  });

  it("selecionar não apaga; apagar remove o que foi selecionado", () => {
    const pastas = montar();
    const alvos = selecionarParaLimpeza(pastas, 90, agora, vivas);
    expect(alvos.every((a) => existsSync(a.caminho))).toBe(true);
    expect(apagar(alvos)).toBe(2);
    expect(alvos.some((a) => existsSync(a.caminho))).toBe(false);
    expect(existsSync(join(pastas.artes, ATIVO))).toBe(true);
  });

  it("prazo inválido é recusado", () => {
    expect(() => selecionarParaLimpeza(montar(), 0, agora)).toThrow();
  });

  it("--telefone apaga artes e log dele, mesmo ativo, e não toca nos outros", () => {
    const pastas = montar();
    writeFileSync(join(pastas.logs, "conv-ativa.jsonl"), "x");
    apagar(selecionarCliente(pastas, ATIVO, "conv-ativa"));
    expect(existsSync(join(pastas.artes, ATIVO))).toBe(false);
    expect(existsSync(join(pastas.logs, "conv-ativa.jsonl"))).toBe(false);
    expect(existsSync(join(pastas.artes, VELHO))).toBe(true);
    expect(existsSync(join(pastas.logs, "conv-antiga.jsonl"))).toBe(true);
  });

  it("--telefone sem nada guardado não seleciona nada; telefone inválido é recusado", () => {
    const pastas = montar();
    expect(selecionarCliente(pastas, "5521900000000", undefined)).toEqual([]);
    expect(() => selecionarCliente(pastas, "abc", undefined)).toThrow();
  });
});

describe("relatorio:piloto", () => {
  const conv = (eventos: Array<Record<string, unknown>>) =>
    eventos.map((e, i) => ({ timestamp: `2026-10-20T10:00:0${i}.000Z`, ...e }));

  it("conta conversas, orçamentos, transferências por motivo, tokens e lacunas", () => {
    const r = resumirLogs([
      conv([
        { type: "message_received" },
        { type: "tool_call", name: "transferir_humano", input: { motivo: "orcamento_para_emitir" }, output: { status: "transferido" } },
        { type: "response_sent", input_tokens: 100, output_tokens: 20 },
      ]),
      conv([
        { type: "message_received" },
        { type: "kb_consulta", pergunta: "Posso retirar?", resultado: "lacuna" },
        { type: "tool_call", name: "transferir_humano", input: { motivo: "lacuna_conhecimento" }, output: { status: "transferido" } },
        { type: "response_sent", input_tokens: 50, output_tokens: 10 },
      ]),
      conv([{ type: "message_received" }, { type: "transfer", motivo: "falha_sistema" }, { type: "alerta", motivo: "teto_do_turno" }]),
    ]);
    expect(r.conversas).toBe(3);
    expect(r.orcamentosParaEmitir).toBe(1);
    expect(r.transferencias).toEqual({
      total: 3,
      porMotivo: { orcamento_para_emitir: 1, lacuna_conhecimento: 1, "falha_sistema (sistema)": 1 },
      conversasTransferidas: 3,
    });
    expect(r.tokens).toEqual({ entrada: 150, saida: 30 });
    expect(r.lacunas).toEqual([{ pergunta: "posso retirar?", vezes: 1 }]);
    const md = formatarRelatorio(r);
    expect(md).toContain("| Conversas transferidas | 3 (100%) |");
    expect(md).toContain("| Orçamentos enviados para emitir | 1 |");
    expect(md).toContain("posso retirar? (1×)");
  });

  it("--desde corta eventos antigos", () => {
    const r = resumirLogs([[{ timestamp: "2026-10-01T00:00:00Z", type: "message_received" }]], "2026-10-15");
    expect(r.conversas).toBe(0);
  });
});
