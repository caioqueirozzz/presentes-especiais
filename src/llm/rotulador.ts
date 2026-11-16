/**
 * Rótulo de TIPO do produto, pelo `gpt-4o-mini` (spec §3.1).
 *
 * Uma chamada curta por produto, com nome, categorias e os primeiros ~300
 * caracteres da descrição. O prompt leva ~15 exemplos e a lista de tipos já
 * usados: sem ela o modelo inventa um rótulo novo para cada caneca e o filtro
 * por tipo deixa de agrupar o que é a mesma coisa.
 *
 * Saída em JSON (`{"tipo": "..."}`) e canonizada por `canonizarTipo` antes de
 * virar dado — o modelo erra o plural e a maiúscula com frequência.
 */
import OpenAI from "openai";
import { canonizarTipo } from "../catalogo/tipos.js";

export const MODELO_ROTULO = "gpt-4o-mini";
/** Chamadas de rótulo em paralelo (spec §3.3). */
export const CONCORRENCIA_ROTULO = 5;
/** Tipos já usados enviados como referência: o suficiente para orientar sem estourar o prompt. */
const MAX_TIPOS_NO_PROMPT = 400;

export interface ClienteRotulo {
  chat: {
    completions: {
      create(body: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        response_format?: { type: "json_object" };
        max_completion_tokens?: number;
      }): Promise<{ choices: Array<{ message: { content: string | null } }> }>;
    };
  };
}

export function clienteRotuloPadrao(apiKey: string): ClienteRotulo {
  return new OpenAI({ apiKey }) as unknown as ClienteRotulo;
}

const EXEMPLOS = [
  ["Caneca de Porcelana Personalizada 325ml", "caneca"],
  ["Caneca Mágica Preta Personalizada", "caneca"],
  ["Porta Latas Camisa Personalizado", "porta-latas"],
  ["Camisa Dry Fit Masculina Personalizada", "camiseta"],
  ["Camiseta Algodão Branca", "camiseta"],
  ["Caneta Esferográfica Plástica Personalizada", "caneta"],
  ["Caneta Metal Roller Premium", "caneta"],
  ["Escova Mágica para Cabelo", "escova"],
  ["Copo de Vidro para Cerveja 300ml", "copo"],
  ["Garrafa Térmica Inox 500ml", "garrafa"],
  ["Miniatura Empilhadeira Metal Colecionável", "miniatura de empilhadeira"],
  ["Carro Miniatura Fusca Metal", "miniatura de carro"],
  ["Caixa de Som Bluetooth com Microfone", "caixa de som"],
  ["Mochila Executiva para Notebook", "mochila"],
  ["Chaveiro Metal Personalizado", "chaveiro"],
  ["Ecobag Personalizada de Algodão Cru", "ecobag"],
  ["Squeeze de Alumínio Personalizado 500ml", "squeeze"],
] as const;

const REGRAS = `Você classifica brindes corporativos pelo TIPO do objeto.

O tipo é o objeto em si: curto, no SINGULAR, minúsculo, sem marca, sem cor, sem material e sem medida.
- "Caneca de Porcelana Personalizada 325ml" -> "caneca" (porcelana é material, 325ml é medida)
- Só mantenha o complemento quando o objeto não se define sem ele: "miniatura de empilhadeira" e "miniatura de carro" são tipos DIFERENTES.
- Vá pelo que o objeto É, não pelo que está estampado nele: um porta-latas em formato de camisa é "porta-latas", não "camiseta".
- USE A PALAVRA DO PRÓPRIO NOME quando ela já nomeia o objeto. "Ecobag Personalizada" é "ecobag", não "sacola"; "Squeeze de Alumínio" é "squeeze", não "garrafa". Trocar pelo sinônimo faz o cliente que digita a palavra do nome não achar o produto.
- Reaproveite um tipo da lista de tipos já usados sempre que o produto for a mesma coisa. Só crie um tipo novo quando nenhum servir.

Responda SÓ com JSON: {"tipo": "..."}`;

function prompt(tiposUsados: string[]): string {
  const exemplos = EXEMPLOS.map(([nome, tipo]) => `${nome} -> ${tipo}`).join("\n");
  const usados = tiposUsados.slice(0, MAX_TIPOS_NO_PROMPT);
  const lista = usados.length > 0 ? `\n\nTipos já usados no catálogo:\n${usados.join(", ")}` : "";
  return `${REGRAS}\n\nExemplos:\n${exemplos}${lista}`;
}

export interface ProdutoParaRotular {
  id: string;
  nome: string;
  categorias: string[];
  descricao: string;
}

function descrever(p: ProdutoParaRotular): string {
  const descricao = p.descricao.replace(/\s+/g, " ").trim().slice(0, 300);
  const linhas = [`Nome: ${p.nome}`];
  if (p.categorias.length) linhas.push(`Categorias: ${p.categorias.join(", ")}`);
  if (descricao) linhas.push(`Descrição: ${descricao}`);
  return linhas.join("\n");
}

/** Rótulo de um produto. `""` quando o modelo não devolveu tipo utilizável. */
export async function rotularProduto(
  cliente: ClienteRotulo,
  produto: ProdutoParaRotular,
  tiposUsados: string[],
  modelo = MODELO_ROTULO
): Promise<string> {
  const resposta = await cliente.chat.completions.create({
    model: modelo,
    messages: [
      { role: "system", content: prompt(tiposUsados) },
      { role: "user", content: descrever(produto) },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: 60,
  });
  const bruto = resposta.choices[0]?.message.content ?? "";
  try {
    const lido = JSON.parse(bruto) as { tipo?: unknown };
    return typeof lido.tipo === "string" ? canonizarTipo(lido.tipo) : "";
  } catch {
    return "";
  }
}

export interface ResultadoRotulagem {
  /** produto_id → tipo canônico. Só os que deram certo. */
  tipos: Map<string, string>;
  /** Produtos que o modelo não conseguiu rotular (rede, JSON quebrado ou tipo vazio). */
  falhas: Array<{ id: string; erro: string }>;
}

/**
 * Rotula uma lista de produtos com concorrência limitada.
 *
 * Os tipos que vão saindo entram na lista enviada ao modelo nas chamadas
 * seguintes, então o catálogo converge para um vocabulário pequeno em vez de um
 * rótulo diferente por produto.
 */
export async function rotularEmLote(
  cliente: ClienteRotulo,
  produtos: ProdutoParaRotular[],
  tiposIniciais: string[] = [],
  opcoes: { concorrencia?: number; modelo?: string; onProgresso?: (feitos: number, total: number) => void } = {}
): Promise<ResultadoRotulagem> {
  const concorrencia = Math.max(1, opcoes.concorrencia ?? CONCORRENCIA_ROTULO);
  const tipos = new Map<string, string>();
  const falhas: ResultadoRotulagem["falhas"] = [];
  const vocabulario = new Set(tiposIniciais.filter(Boolean));

  let proximo = 0;
  let feitos = 0;

  async function trabalhador(): Promise<void> {
    while (proximo < produtos.length) {
      const p = produtos[proximo++];
      try {
        const tipo = await rotularProduto(cliente, p, [...vocabulario].sort(), opcoes.modelo);
        if (tipo) {
          tipos.set(p.id, tipo);
          vocabulario.add(tipo);
        } else {
          falhas.push({ id: p.id, erro: "tipo_vazio" });
        }
      } catch (err) {
        falhas.push({ id: p.id, erro: err instanceof Error ? err.message : String(err) });
      }
      feitos++;
      opcoes.onProgresso?.(feitos, produtos.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concorrencia, produtos.length) }, trabalhador));
  return { tipos, falhas };
}
