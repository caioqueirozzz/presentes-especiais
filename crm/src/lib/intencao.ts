/*
 * Palavras-chave que mudam o rumo do atendimento antes de o modelo responder.
 *
 * - cancelamento/estorno: a Lia nunca responde; a conversa vai direto para uma pessoa, marcada como urgente.
 * - reclamação: o CRM marca o contato do cliente (quem já tem pedido) como urgente.
 *
 * ESTE ARQUIVO TEM UMA CÓPIA IDÊNTICA EM crm/src/lib/intencao.ts (o CRM é outro projeto e não importa
 * daqui). tests/intencao.test.ts falha se as duas divergirem: altere as duas juntas.
 */

export type Intencao = "cancelamento" | "reclamacao";

export interface SinalDeIntencao {
  tipo: Intencao;
  /** Trecho que disparou, para a equipe entender o porquê do aviso. */
  termo: string;
}

/** Minúsculas e sem acento: "Cancelámento", "REEMBOLSO" e "estôrno" caem no mesmo padrão. */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const CANCELAMENTO: RegExp[] = [
  /\bcancel(ar|a|o|e|em|ei|amos|ou|aram|amento|amentos|ado|ada|ados|adas)\b/,
  /\bestorn\w*/,
  /\breembols\w*/,
  /\bressarc\w*/,
  /\bchargeback\b/,
  /\b(meu|o|nosso) dinheiro de volta\b/,
  /\bdevol(ver|vam|ucao|ucao do|va) (o |meu |nosso )?(dinheiro|valor|pagamento|pix)\b/,
  /\b(desist(i|o|ir|imos|indo)|nao quero mais) (d[oa] |o |a |meu |minha |nosso |nossa )?(pedido|compra|encomenda|orcamento)\b/,
  /\b(anular|desfazer) (o |a |meu |minha )?(pedido|compra)\b/,
];

const RECLAMACAO: RegExp[] = [
  /\breclama(r|cao|coes|ndo|ria)?\b/,
  /\bdefeit\w*/,
  /\b(quebrad|danificad|avariad|estragad|rasgad|amassad|manchad|descascad|desbotad|trincad)[oa]s?\b/,
  /\b(veio|vieram|chegou|chegaram|mandaram|enviaram) (tudo |todo |toda )?(errad|trocad)[oa]s?\b/,
  /\b(produto|produtos|cor|quantidade|nome|arte|logo|logomarca|tamanho|modelo)s? (veio |vieram |esta |estao |saiu |sairam )?(errad|trocad)[oa]s?\b/,
  /\b(veio|vieram|chegou|chegaram) faltando\b/,
  /\bfalt(ou|aram|ando) (unidade|unidades|peca|pecas|item|itens|produto|produtos)\b/,
  /\b(nao|nunca|ainda nao) (chegou|chegaram|recebi|recebemos|foi entregue|foram entregues)\b/,
  /\batras(ado|ada|ados|adas|o|ou)\b/,
  /\b(pessim[oa]|horrivel|absurdo|vergonha|descaso|desrespeito|falta de respeito)\b/,
  /\b(decepcion|insatisf)\w*/,
  /\b(procon|reclame aqui|advogad[oa]|processar|justica)\b/,
  /\b(golpe|enganad[oa]s?|fui lesad[oa])\b/,
  /\bmal feit[oa]s?\b/,
  /\b(qualidade|acabamento|impressao|gravacao|estampa) (ruim|pessima|horrivel|baixa)\b/,
  /\b(quero|queria|preciso|gostaria de) (trocar|devolver)\b/,
  /\b(tive|tivemos|teve|deu|houve|estou com|to com|temos) (um |uns |algum |alguns )?problemas?\b/,
  /\bproblemas? (com|no|na|nos|nas) (o |a |os |as |meu |minha |meus |minhas |nosso |nossa )?(pedido|produto|entrega|encomenda|compra|brinde)s?\b/,
];

function primeiro(texto: string, padroes: RegExp[]): string | null {
  for (const p of padroes) {
    const m = p.exec(texto);
    if (m) return m[0];
  }
  return null;
}

/**
 * Cancelamento/estorno vence reclamação ("veio quebrado, quero o estorno" é estorno: nunca passa pela IA).
 * Devolve null quando nada bate.
 */
export function detectarIntencao(texto: string): SinalDeIntencao | null {
  const t = normalizarTexto(texto);
  const cancelamento = primeiro(t, CANCELAMENTO);
  if (cancelamento) return { tipo: "cancelamento", termo: cancelamento };
  const reclamacao = primeiro(t, RECLAMACAO);
  if (reclamacao) return { tipo: "reclamacao", termo: reclamacao };
  return null;
}
