import type { ItemResposta } from "../contrato/esquemas.js";
import type { CanalWhatsApp } from "./canal.js";
import type { LogPonte } from "./log.js";

export const CHAVE_EU = "eu";
export const DIGITANDO_MAX_MS = 4_000;
const VALIDADE_REGISTRO_MS = 120_000;
export const PRAZO_FOTO_MS = 30_000;

export function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function tempoDigitando(texto: string): number {
  return Math.min(DIGITANDO_MAX_MS, 800 + texto.length * 25);
}

export interface Saida {
  /** Vira true quando o eco do envio chega: a mensagem saiu, mesmo que o envio tenha lançado erro. */
  confirmada: boolean;
}

export class RegistroSaida {
  private pendentes: Array<{ chave: string; texto: string; em: number; saida: Saida; imagemUrl?: string }> = [];

  constructor(private readonly validadeMs = VALIDADE_REGISTRO_MS) {}

  registrar(chave: string, texto: string, imagemUrl?: string): Saida {
    const saida: Saida = { confirmada: false };
    this.pendentes.push({ chave, texto: texto.trim(), em: Date.now(), saida, imagemUrl });
    return saida;
  }

  /** Como consumir, mas sem tirar do registro: só pergunta se esta saída foi nossa. */
  contem(chave: string, texto: string): boolean {
    const agora = Date.now();
    return this.pendentes.some((p) => p.chave === chave && p.texto === texto.trim() && agora - p.em <= this.validadeMs);
  }

  /** URL da foto que saiu com esta legenda, sem tirar do registro. */
  imagemDe(chave: string, texto: string): string | undefined {
    const agora = Date.now();
    return this.pendentes.find((p) => p.chave === chave && p.texto === texto.trim() && agora - p.em <= this.validadeMs)?.imagemUrl;
  }

  /** A foto não saiu: a entrada passa a valer só como texto (recuo), sem a URL. */
  tirarImagem(saida: Saida): void {
    const p = this.pendentes.find((x) => x.saida === saida);
    if (p) p.imagemUrl = undefined;
  }

  consumir(chave: string, texto: string): boolean {
    const agora = Date.now();
    this.pendentes = this.pendentes.filter((p) => agora - p.em <= this.validadeMs);
    const i = this.pendentes.findIndex((p) => p.chave === chave && p.texto === texto.trim());
    if (i === -1) return false;
    this.pendentes[i].saida.confirmada = true;
    this.pendentes.splice(i, 1);
    return true;
  }
}

export class LimitadorEnvios {
  private envios: number[] = [];

  constructor(private readonly porMinuto: number) {}

  async aguardarVez(): Promise<void> {
    for (;;) {
      const agora = Date.now();
      this.envios = this.envios.filter((t) => agora - t < 60_000);
      if (this.envios.length < this.porMinuto) {
        this.envios.push(agora);
        return;
      }
      await esperar(this.envios[0] + 60_000 - agora);
    }
  }
}

export class Envio {
  private readonly registro = new RegistroSaida();
  private readonly limitador: LimitadorEnvios;

  constructor(
    private readonly canal: CanalWhatsApp,
    enviosPorMinuto: number,
    private readonly log: LogPonte = () => {}
  ) {
    this.limitador = new LimitadorEnvios(enviosPorMinuto);
  }

  ehMinha(chave: string, texto: string): boolean {
    return this.registro.consumir(chave, texto);
  }

  /** Igual a ehMinha, sem consumir o registro (o Atendimento ainda vai consumir depois). */
  seriaMinha(chave: string, texto: string): boolean {
    return this.registro.contem(chave, texto);
  }

  imagemDe(chave: string, texto: string): string | undefined {
    return this.registro.imagemDe(chave, texto);
  }

  /** `continuar` é conferido logo antes de cada tentativa sair; false cancela o envio (devolve false). */
  paraCliente(telefone: string, chatId: string, item: ItemResposta, continuar: () => boolean = () => true): Promise<boolean> {
    return typeof item === "string"
      ? this.enviar(telefone, chatId, item, true, continuar)
      : this.enviarFoto(telefone, chatId, item, continuar);
  }

  /** Uma tentativa de foto. Se falhar, a legenda vai como texto, com a nova tentativa do texto. */
  private async enviarFoto(
    chave: string,
    chatId: string,
    foto: { imagem_url: string; legenda: string },
    continuar: () => boolean
  ): Promise<boolean> {
    await this.canal.digitando(chatId).catch(() => {});
    await esperar(tempoDigitando(foto.legenda));
    await this.limitador.aguardarVez();
    if (!continuar()) return false;
    // Registra antes de enviar: o eco da foto (a legenda) chega antes do envio resolver.
    const saida = this.registro.registrar(chave, foto.legenda, foto.imagem_url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const prazo = new Promise<never>((_, rejeitar) => {
      timer = setTimeout(() => rejeitar(new Error("prazo da foto esgotado")), PRAZO_FOTO_MS);
    });
    try {
      // Sem prazo, download lento deixaria o eco chegar com o registro já expirado (viraria "atendente").
      // shortcut: foto que sai depois de PRAZO_FOTO_MS chega junto com o texto do recuo e o 2º eco pausa a IA; trocar por AbortController se o dogfooding mostrar isso.
      await Promise.race([this.canal.enviarImagem(chatId, foto.imagem_url, foto.legenda), prazo]);
      return true;
    } catch (err) {
      this.log({ type: "foto_falhou", erro: String(err) });
      if (saida.confirmada) return true;
      // O recuo reaproveita esta entrada, sem URL: o eco do texto não pode virar "foto" nem confirmar outra saída.
      this.registro.tirarImagem(saida);
      return this.enviar(chave, chatId, foto.legenda, false, continuar, saida);
    } finally {
      clearTimeout(timer);
    }
  }

  paraMim(texto: string): Promise<boolean> {
    return this.enviar(CHAVE_EU, this.canal.meuChatId(), texto, false, () => true);
  }

  private async enviar(
    chave: string,
    chatId: string,
    texto: string,
    digitar: boolean,
    continuar: () => boolean,
    saidaInicial?: Saida
  ): Promise<boolean> {
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      if (digitar) {
        await this.canal.digitando(chatId).catch(() => {});
        await esperar(tempoDigitando(texto));
      }
      // A vaga do limite é tomada só agora, no instante do envio, e não antes do "digitando".
      await this.limitador.aguardarVez();
      if (!continuar()) return false;
      // Registra antes de enviar: o eco (message_create) chega antes do envio resolver.
      // Em falha o registro fica até expirar, porque a mensagem pode ter saído mesmo assim.
      const saida = tentativa === 1 && saidaInicial ? saidaInicial : this.registro.registrar(chave, texto);
      try {
        await this.canal.enviar(chatId, texto);
        return true;
      } catch (err) {
        this.log({ type: "envio_falhou", tentativa, erro: String(err) });
        if (saida.confirmada) return true;
      }
    }
    return false;
  }
}
