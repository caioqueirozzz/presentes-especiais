/**
 * Retenção de dados de cliente (issue #4, LGPD). O prazo é decisão da loja: o padrão de 90 dias
 * é só ponto de partida e vem de RETENCAO_DIAS. Nada é apagado sem `--executar`.
 *
 * Critério: idade = tempo desde a última gravação. A conversa é regravada a cada mensagem, então
 * parada = cliente parado. As artes de um telefone saem junto com a conversa dele (ou quando não há
 * conversa), e só se a arte mais nova também passou do prazo.
 *
 * Conversas, lacunas e o estado da ponte moram no banco: ver retencaoBanco.ts. Aqui ficam só os arquivos.
 */
import { existsSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";

export interface AlvoRetencao {
  tipo: "artes" | "log";
  caminho: string;
  idadeDias: number;
  bytes: number;
}

export interface PastasRetencao {
  artes: string;
  logs: string;
}

/** Logs que não são de conversa: ficam, mesmo antigos (api.jsonl só tem rota, status e duração). */
const LOGS_PRESERVADOS = new Set(["api.jsonl"]);

const DIA_MS = 86_400_000;

function idadeDias(mtimeMs: number, agora: number): number {
  return Math.floor((agora - mtimeMs) / DIA_MS);
}

/** Idade pelos arquivos de dentro; pasta vazia vale pela própria data. */
function tamanhoEMaisNovo(dir: string): { bytes: number; maisNovo: number } {
  let bytes = 0;
  let maisNovo = 0;
  for (const nome of readdirSync(dir)) {
    const st = statSync(join(dir, nome));
    if (st.isDirectory()) {
      const sub = tamanhoEMaisNovo(join(dir, nome));
      bytes += sub.bytes;
      maisNovo = Math.max(maisNovo, sub.maisNovo);
    } else {
      bytes += st.size;
      maisNovo = Math.max(maisNovo, st.mtimeMs);
    }
  }
  return { bytes, maisNovo: maisNovo || statSync(dir).mtimeMs };
}

export function selecionarParaLimpeza(pastas: PastasRetencao, dias: number, agora = Date.now(), conversasVivas: Set<string> = new Set()): AlvoRetencao[] {
  if (!Number.isFinite(dias) || dias < 1) throw new Error("prazo de retenção precisa ser de pelo menos 1 dia");
  const limite = agora - dias * DIA_MS;
  const alvos: AlvoRetencao[] = [];

  if (existsSync(pastas.artes)) {
    for (const nome of readdirSync(pastas.artes)) {
      const caminho = join(pastas.artes, nome);
      if (!statSync(caminho).isDirectory() || conversasVivas.has(nome)) continue;
      const { bytes, maisNovo } = tamanhoEMaisNovo(caminho);
      if (maisNovo < limite) alvos.push({ tipo: "artes", caminho, idadeDias: idadeDias(maisNovo, agora), bytes });
    }
  }

  if (existsSync(pastas.logs)) {
    for (const nome of readdirSync(pastas.logs)) {
      if (!nome.endsWith(".jsonl") || LOGS_PRESERVADOS.has(nome)) continue;
      const caminho = join(pastas.logs, nome);
      const st = statSync(caminho);
      if (st.mtimeMs < limite) alvos.push({ tipo: "log", caminho, idadeDias: idadeDias(st.mtimeMs, agora), bytes: st.size });
    }
  }

  return alvos;
}

/** Tudo de um cliente que pediu para ser apagado (LGPD), mesmo com a conversa ativa. */
export function selecionarCliente(pastas: PastasRetencao, telefone: string, conversaId: string | undefined, agora = Date.now()): AlvoRetencao[] {
  if (!/^\d{10,15}$/.test(telefone)) throw new Error("telefone só com dígitos, com DDI");
  const alvos: AlvoRetencao[] = [];

  const artes = join(pastas.artes, telefone);
  if (existsSync(artes)) {
    const { bytes, maisNovo } = tamanhoEMaisNovo(artes);
    alvos.push({ tipo: "artes", caminho: artes, idadeDias: idadeDias(maisNovo, agora), bytes });
  }

  const log = conversaId ? join(pastas.logs, `${conversaId}.jsonl`) : undefined;
  if (log && existsSync(log)) {
    const st = statSync(log);
    alvos.push({ tipo: "log", caminho: log, idadeDias: idadeDias(st.mtimeMs, agora), bytes: st.size });
  }

  return alvos;
}

/** Apaga de vez. Só o script chama, e só com --executar. */
export function apagar(alvos: AlvoRetencao[]): number {
  let apagados = 0;
  for (const a of alvos) {
    rmSync(a.caminho, { recursive: a.tipo === "artes", force: true });
    apagados++;
  }
  return apagados;
}
