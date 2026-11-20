import type { Banco } from "../db/banco.js";
import { normalizarTelefone } from "./telefone.js";

/*
 * Modo de atendimento da Lia, escolhido no CRM (aba Conexão) e guardado no banco pela ponte:
 *  ligada    — responde a todo cliente que escrever no número da loja
 *  teste     — responde só aos números de teste; os demais ficam para a equipe
 *  desligada — não responde ninguém; as mensagens continuam chegando ao CRM
 * Mensagem que a Lia não atende fica não lida no celular, como antes com WHATSAPP_LIBERADOS.
 */

export const MODOS_LIA = ["ligada", "teste", "desligada"] as const;
export type ModoLia = (typeof MODOS_LIA)[number];

export const MAX_NUMEROS_TESTE = 20;

export interface ConfigLia {
  modo: ModoLia;
  numerosTeste: string[];
  atualizadoEm: string | null;
}

/** Número digitado no CRM ("(83) 99999-0000") no formato da ponte: com 55 e o nono dígito. */
export function telefoneDeTeste(entrada: string): string | null {
  const d = entrada.replace(/\D/g, "");
  if (d.length < 10 || d.length > 13) return null;
  return normalizarTelefone(d.length <= 11 ? `55${d}` : d);
}

/** Sem arquivo salvo: WHATSAPP_LIBERADOS do .env vira modo teste; sem ele, ligada (o comportamento de antes). */
export function configLiaPadrao(liberados: string[]): ConfigLia {
  const numeros = [...new Set(liberados.map(telefoneDeTeste).filter((n): n is string => n !== null))];
  return { modo: numeros.length > 0 ? "teste" : "ligada", numerosTeste: numeros, atualizadoEm: null };
}

/** Confere o que veio do CRM. Devolve a mensagem de erro em texto quando não serve. */
export function validarConfigLia(entrada: Record<string, unknown>): Omit<ConfigLia, "atualizadoEm"> | string {
  const modo = entrada.modo;
  if (typeof modo !== "string" || !(MODOS_LIA as readonly string[]).includes(modo)) return "modo deve ser ligada, teste ou desligada";
  const lista = Array.isArray(entrada.numerosTeste) ? entrada.numerosTeste : [];
  const numeros: string[] = [];
  for (const item of lista) {
    const numero = typeof item === "string" ? telefoneDeTeste(item) : null;
    if (!numero) return `número de teste inválido: ${String(item)}`;
    if (!numeros.includes(numero)) numeros.push(numero);
  }
  if (numeros.length > MAX_NUMEROS_TESTE) return `no máximo ${MAX_NUMEROS_TESTE} números de teste`;
  if (modo === "teste" && numeros.length === 0) return "o modo teste precisa de pelo menos um número";
  return { modo: modo as ModoLia, numerosTeste: numeros };
}

export function iaAtende(config: ConfigLia, telefone: string): boolean {
  if (config.modo === "ligada") return true;
  if (config.modo === "desligada") return false;
  return config.numerosTeste.includes(normalizarTelefone(telefone));
}

export interface ArmazemModoLia {
  ler(): Promise<ConfigLia>;
  salvar(config: Omit<ConfigLia, "atualizadoEm">): Promise<ConfigLia>;
}

function lerSalvo(salvo: unknown, padrao: ConfigLia): ConfigLia {
  if (!salvo || typeof salvo !== "object") return padrao;
  const valido = validarConfigLia(salvo as Record<string, unknown>);
  if (typeof valido === "string") return padrao;
  const em = (salvo as Record<string, unknown>).atualizadoEm;
  return { ...valido, atualizadoEm: typeof em === "string" ? em : null };
}

export class MemoriaModoLia implements ArmazemModoLia {
  private salvo: ConfigLia | null = null;
  constructor(private readonly padrao: ConfigLia) {}
  async ler(): Promise<ConfigLia> {
    return this.salvo ?? this.padrao;
  }
  async salvar(config: Omit<ConfigLia, "atualizadoEm">): Promise<ConfigLia> {
    this.salvo = { ...config, atualizadoEm: new Date().toISOString() };
    return this.salvo;
  }
}

export class PgModoLia implements ArmazemModoLia {
  constructor(
    private readonly banco: Banco,
    private readonly padrao: ConfigLia
  ) {}

  async ler(): Promise<ConfigLia> {
    const [linha] = await this.banco.query<{ config: unknown }>("SELECT config FROM agente.modo_lia WHERE id = 1");
    return lerSalvo(linha?.config, this.padrao);
  }

  async salvar(config: Omit<ConfigLia, "atualizadoEm">): Promise<ConfigLia> {
    const completo: ConfigLia = { ...config, atualizadoEm: new Date().toISOString() };
    await this.banco.query(
      `INSERT INTO agente.modo_lia (id, config, atualizado_em) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, atualizado_em = now()`,
      [JSON.stringify(completo)]
    );
    return completo;
  }
}
