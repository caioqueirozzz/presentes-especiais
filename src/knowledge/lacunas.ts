/**
 * Lacunas da base de conhecimento (Fase 3): perguntas que o cliente fez e a
 * base não soube responder. Viram a fila de trabalho da loja — o que mais
 * aparece aqui é o próximo item a escrever e aprovar.
 *
 * Guarda a pergunta mascarada (telefone, e-mail e CPF) e o id da conversa; nada
 * além disso.
 */
import { tokenizar } from "../busca/texto.js";
import { mascararTexto } from "../logging/logger.js";
import { logarErroBanco, type Banco } from "../db/banco.js";

export interface Lacuna {
  pergunta: string;
  conversa_id: string;
  /** Categoria que o modelo achou mais provável, se informou. */
  categoria_sugerida?: string;
  registrado_em: string;
}

export interface LacunaStore {
  registrar(lacuna: Lacuna): Promise<void>;
  listar(): Promise<Lacuna[]>;
}

const LIMITE_PERGUNTA = 300;

export function criarLacuna(
  pergunta: string,
  conversaId: string,
  categoriaSugerida?: string,
  agora = new Date()
): Lacuna {
  return {
    pergunta: mascararTexto(pergunta).slice(0, LIMITE_PERGUNTA),
    conversa_id: conversaId,
    categoria_sugerida: categoriaSugerida,
    registrado_em: agora.toISOString(),
  };
}

export class MemoryLacunaStore implements LacunaStore {
  private readonly itens: Lacuna[] = [];
  async registrar(l: Lacuna): Promise<void> {
    this.itens.push(l);
  }
  async listar(): Promise<Lacuna[]> {
    return [...this.itens];
  }
}

export class PgLacunaStore implements LacunaStore {
  constructor(private readonly banco: Banco) {}

  async registrar(l: Lacuna): Promise<void> {
    try {
      await this.banco.query(
        "INSERT INTO agente.lacunas (conversa_id, pergunta, categoria_sugerida, registrado_em) VALUES ($1, $2, $3, $4)",
        [l.conversa_id, l.pergunta, l.categoria_sugerida ?? null, l.registrado_em]
      );
    } catch (err) {
      // Registrar lacuna não pode derrubar o atendimento.
      console.error(JSON.stringify({ type: "lacuna_nao_registrada", ...logarErroBanco(err) }));
    }
  }

  async listar(): Promise<Lacuna[]> {
    const linhas = await this.banco.query<{ conversa_id: string; pergunta: string; categoria_sugerida: string | null; registrado_em: Date }>(
      "SELECT conversa_id, pergunta, categoria_sugerida, registrado_em FROM agente.lacunas ORDER BY registrado_em, id"
    );
    return linhas.map((r) => ({
      pergunta: r.pergunta,
      conversa_id: r.conversa_id,
      ...(r.categoria_sugerida ? { categoria_sugerida: r.categoria_sugerida } : {}),
      registrado_em: new Date(r.registrado_em).toISOString(),
    }));
  }
}

export interface LacunaAgrupada {
  pergunta_exemplo: string;
  ocorrencias: number;
  conversas: number;
  ultima_em: string;
  categoria_sugerida?: string;
}

/**
 * Junta perguntas parecidas ("qual o CNPJ de vocês?" / "me passa o cnpj da
 * loja") pelas palavras que sobram depois de tirar as vazias.
 */
export function agruparLacunas(lacunas: Lacuna[]): LacunaAgrupada[] {
  const grupos = new Map<string, { itens: Lacuna[] }>();
  for (const l of lacunas) {
    const chave = [...new Set(tokenizar(l.pergunta))].sort().join(" ") || l.pergunta.toLowerCase();
    const g = grupos.get(chave) ?? { itens: [] };
    g.itens.push(l);
    grupos.set(chave, g);
  }
  return [...grupos.values()]
    .map(({ itens }) => {
      const ultima = itens.reduce((a, b) => (a.registrado_em > b.registrado_em ? a : b));
      return {
        pergunta_exemplo: ultima.pergunta,
        ocorrencias: itens.length,
        conversas: new Set(itens.map((i) => i.conversa_id)).size,
        ultima_em: ultima.registrado_em,
        categoria_sugerida: itens.find((i) => i.categoria_sugerida)?.categoria_sugerida,
      };
    })
    .sort((a, b) => b.ocorrencias - a.ocorrencias || (a.ultima_em < b.ultima_em ? 1 : -1));
}
