# Busca semântica: design

**Data:** 09/11/2026 · **Implementa:** Gui · **Revisa:** João · **Branch:** `busca-semantica`, a partir de `preco-de-venda-do-site`
**Base:** Fase 0 (preço do site) e os achados de `docs/dogfooding-fase-0.md`.

## 1. Problema

A busca de `buscar_produtos` é lexical (BM25 em `src/catalogo/recomendar.ts`, motor em `src/busca/bm25.ts`). Basta uma palavra do nome casar, então o top-3 traz produtos de outro tipo. Casos reais do dogfooding de 09/11:

| Pedido | O que veio |
|---|---|
| "camisas dry fit" (10, 25 e 100 un.) | Porta Latas Camisa Personalizado |
| "canecas mágicas" | Escova Mágica, Copo de Vidro para Cerveja |
| "miniaturas de empilhadeira" (sem estoque para 200) | 3 × Carro Miniatura |

Quando o produto pedido sai por estoque ou mínimo, sobram os vizinhos de palavra. E como a resposta da busca com cartão tem texto fixo ("Separei esta opção para você..."), o cliente não fica sabendo que o tipo é outro.

## 2. Objetivo e critérios de aceite

O top-3 só traz produtos do tipo que o cliente pediu. Quando não há produto desse tipo que feche as regras, a resposta diz isso, em vez de mostrar outra coisa.

A fase está pronta quando **todos** passarem:

1. **Tipo certo:** em ≥ 90% dos itens de top-3 das 40 consultas da medição (seção 8), o `tipo` é o pedido; nenhum dos 10 casos do dogfooding traz produto de outro tipo.
2. **Melhor que o BM25:** na revisão do João, a semântica empata ou ganha do BM25 em ≥ 80% das 40 consultas.
3. **Evals:** `npm run evals -- --rodadas 3` mantém o patamar de 09/11 (todos em 3/3, exceto `16_lacuna_conhecimento` e `39_orcamento_sem_dados`, falhas conhecidas); os 5 evals novos (seção 7) passam em 3/3.
4. **Suíte verde:** `npm run typecheck` e `npx vitest run --maxWorkers=1 --minWorkers=1`.
5. **Latência:** o p95 de `buscar_produtos` sobe no máximo 500 ms.

## 3. Componentes

### 3.1 Tipo do produto (`TipoStore`)

- Cada produto ganha um `tipo` canônico: o objeto em si, curto, no singular, minúsculo, sem marca, cor nem material ("camiseta", "porta-latas", "caneca", "caneta"). Quando o objeto só se define com o complemento, ele fica: "miniatura de empilhadeira" e "miniatura de carro" são tipos diferentes; "Caneca de Porcelana Personalizada" é só "caneca".
- Rotulado pelo `gpt-4o-mini` com nome, categorias e os primeiros ~300 caracteres da descrição (sem HTML). Prompt com ~15 exemplos e uma lista de tipos já usados, para o modelo reaproveitar o mesmo rótulo. Saída em JSON estruturado (`{ "tipo": string }`).
- Só rotula produto novo ou com `atualizado_em` diferente do gravado.
- Grava em `data/tipos-produto.json`: `{ versao: 1, produtos: { [produto_id]: { tipo, atualizado_em } } }`.
- **Correção manual:** `src/knowledge/tipos-corrigidos.json` (`produto_id → tipo`) vence o rótulo do modelo. Recarrega quando o arquivo muda, como `etiquetas-ocasiao.json`.
- Interface nova `TipoStore` (`carregar()`, `salvar()`) com a versão em arquivo. A versão Postgres é da Fase 1 (João).

### 3.2 Vetores (`VectorStore`)

- Modelo: `text-embedding-3-small` (1536 dimensões), pelo cliente `openai` que o projeto já usa (`src/llm/openai.ts`, `OPENAI_API_KEY`).
- Por produto, o **vetor do texto**: nome + categorias + descrição curta (o mesmo texto do rótulo).
- Por tipo distinto, o **vetor do tipo** (poucas centenas; deduplicado).
- Normalizados (norma 1), para o cosseno virar produto escalar.
- Gravação em binário: `data/vetores-produto.bin` (`Float32Array` contígua) + `data/vetores-produto.json` (ids na ordem, `atualizado_em`, modelo, dimensão). Idem para os tipos (`data/vetores-tipo.*`). ~20 MB para 6,5 mil produtos.
- Interface nova `VectorStore` com a versão em arquivo; a busca carrega uma vez e guarda em memória (mesma regra de "mesma referência enquanto não mudar" do `ProductIndexStore`).

### 3.3 Script de geração

- `scripts/gerarVetores.ts` (`npm run gerar:vetores`): rótulo de tipo + vetores, só do que mudou. Também roda no fim do `sync:catalogo` com sucesso.
- Lotes de 100 textos por chamada de embedding; até 5 chamadas de rótulo em paralelo.
- **Trava:** com mais de 5% de produtos sem rótulo ou sem vetor, não grava nada e sai com código 1 (mesma regra do `sync:precos`). No fim, lista os produtos que falharam.

### 3.4 Parâmetro novo em `buscar_produtos`

Em `src/tools/buscarProdutos.ts` (schema) e `src/tools/index.ts` (descrição):

- `tipo_produto` (opcional, string curta): "o tipo de produto que o cliente nomeou, no singular (camiseta, caneca, caneta). Omita se ele não nomeou um tipo (ex.: 'algo para professores')."
- `quantidade`: a descrição passa a dizer "Omita se o cliente não disse um número. Nunca use 1 por padrão."

### 3.5 Motor semântico em `recomendar.ts`

Troca `motorDe` (BM25) por um motor com a mesma saída: candidatos com `similaridade` entre 0 e 1.

1. **Filtro por tipo** (só com `tipo_produto`): embedding de `tipo_produto` (cache em memória por texto normalizado) contra o vetor do tipo de cada produto. Entra quem passa do **piso de tipo**, calibrado na medição (seção 8) e registrado nesta spec com o motivo. Produto sem tipo não entra.
2. **Ordem:** cosseno entre o embedding de `consulta` e o vetor do texto. Continua a fórmula `relevancia` de hoje (`PESO_SIMILARIDADE`, `PESO_OCASIAO`, `PESO_DESTAQUE`).
3. Sem `tipo_produto`: só a ordem por cosseno, com as etiquetas de ocasião como hoje.
4. Daí para a frente, **nada muda**: `calcularOferta` (mínimo, estoque, valor), revalidação ao vivo, cotação exata, cartões e `MAX_OPCOES = 3`.

### 3.6 BM25 como reserva

- Falha ao gerar o embedding da consulta (rede, 429, 5xx da OpenAI): a busca usa o BM25 de hoje e loga `busca_degradada` com o motivo.
- Produto sem vetor (novo desde a última geração): entra só pelo BM25 até a próxima geração.
- O `src/busca/bm25.ts` fica; não apagar.

## 4. Fluxo na conversa

1. **Nenhum produto do tipo pedido:** com `tipo_produto` e nenhum produto acima do piso, a ferramenta devolve `resultado: "nenhum_do_tipo"` com o `tipo_pedido`, sem cartões e sem vizinhos de outro tipo. A instrução ao agente: dizer em uma frase que não há esse tipo para a quantidade e oferecer o atendimento humano. Sem cartão, a frase fixa não entra (ela só vale com cartão, `src/agent/runTurn.ts`).
2. **Do tipo, mas sai por estoque ou mínimo:** segue o `ajustes_sugeridos` de hoje (`src/catalogo/recomendar.ts`), só com produtos do mesmo tipo.
3. **"Dessa" usa o produto sugerido:** todo produto de `ajustes_sugeridos` passa por `discutirProduto` e entra em `state.ultimasOpcoes` com as cores (como os itens recomendados, em `buscarProdutos.ts`). A descrição de `detalhar_produto` passa a citar o `produto_id` de `ajustes_sugeridos` como fonte válida. Assim "quero 200 dessa" vira `detalhar_produto` desse id, e o `preparar_orcamento` aceita o produto.
4. **Sem quantidade:** a busca cota cada produto na sua quantidade mínima, e o cartão sai com "R$ X/un no pedido mínimo de N un." (em `src/tools/cartao.ts`, `montarCartao`). A IA pergunta quantas unidades.
5. **Não muda:** texto fixo da busca com cartão, texto do modelo com filtro no `detalhar_produto`, orçamento e transferência.

## 5. Erros

| Situação | Comportamento |
|---|---|
| OpenAI fora na busca | BM25 + log `busca_degradada` |
| Produto sem vetor ou sem tipo | Só pelo BM25 (sem vetor) / fora do filtro de tipo (sem tipo) até a próxima geração |
| Geração com > 5% de falha | Não grava; sai com código 1; lista os ids |
| Tipo rotulado errado | `tipos-corrigidos.json`, vale no próximo carregamento, sem deploy |
| Arquivos de vetor ausentes | A busca roda em BM25 e loga `busca_degradada` uma vez por carga |

## 6. Custo e desempenho

- Rótulo inicial: ~6,5 mil chamadas curtas ao `gpt-4o-mini` (< US$ 1); depois, só os alterados.
- Embeddings dos produtos: centavos.
- Por busca: 1 embedding da consulta + 1 do tipo (cacheado). +100 a 300 ms.
- Cosseno contra 6,5 mil vetores em memória: < 10 ms.
- Memória: ~20 MB de vetores. O PC de dev tem 7,8 GB; não carregar em JSON.

## 7. Testes e evals

**Unidade** (vitest, sem rede, com vetores falsos):
- cosseno e normalização;
- filtro por tipo: abaixo do piso sai, produto sem tipo sai;
- `nenhum_do_tipo` sem cartões;
- ajustes só do mesmo tipo;
- "dessa": produto de `ajustes_sugeridos` entra em `ultimasOpcoes` e o `detalhar_produto` aceita o id;
- sem quantidade: cotação no mínimo e texto do cartão;
- BM25 de reserva quando o embedding falha;
- trava de 5% no `gerarVetores`.

**Evals novos** (`evals/scenarios/`, numeração a partir de 42). O mock (`mocks/products.json`) ganha produtos com palavra em comum e tipo diferente (um porta-latas "camisa", uma escova "mágica", um carro "miniatura"):
1. "camisa dry fit" não traz o porta-latas;
2. "caneca mágica" não traz a escova;
3. produto sem estoque para a quantidade: nenhum vizinho de outro tipo;
4. "quero N dessa" depois de um ajuste chama `detalhar_produto` com o id do ajuste;
5. pedido sem número: `buscar_produtos` vai sem `quantidade`.

Os evals rodam com o modelo real e vetores reais do mock (gerar com `gerar:vetores` em modo mock).

## 8. Medição

- Arquivo novo `evals/recomendacao/consultas-semantica.json`: as 30 de `evals/recomendacao/pedidos.json` + 10 do dogfooding (camisa dry fit, caneca mágica, miniatura de empilhadeira, caixa de som com microfone, caneta plástica e outras 5 com palavra ambígua).
- `scripts/avaliarRecomendacao.ts` ganha o modo `--comparar`: para cada consulta, contra o índice real (`BRINDEME_MODE=http`), o top-3 do BM25 e o top-3 da semântica lado a lado, com nome, `tipo`, slug e o link `https://presentesespeciais.com.br/brinde/<slug>`. Saída em Markdown (`../Validações/busca-semantica-comparacao.md`, fora do repo, como os relatórios de eval), com uma coluna para o João marcar certo/errado.
- O piso de tipo é calibrado nessa rodada: o menor valor que zera os casos do dogfooding sem tirar o produto certo de nenhuma das 40. Valor e motivo entram nesta spec.
- O João revisa no Claude Desktop, abrindo as páginas.

## 9. Fronteira com a Fase 1 (Neon)

- O Gui cria só as interfaces `TipoStore` e `VectorStore` e a versão em arquivo.
- A versão Postgres (`pgvector`) e a migration são do João, na Fase 1, atrás das mesmas interfaces.
- Nada nesta fase lê ou escreve no Neon.

## 10. Entrega

- Branch `busca-semantica` a partir de `preco-de-venda-do-site` (nome pela função, sem "fase").
- Antes do push, juntar os commits: um `docs`, um `feat` e um `fix` (correções vão separadas).
- A comparação revisada e o piso calibrado vão no PR.

## 11. Fora do escopo

- Imagens (Módulo Design, Fase 3) e áudio (Fase 4).
- Lote processado duas vezes na ponte (`docs/dogfooding-fase-0.md`, seção 4): task separada.
- `sync:catalogo` frequente: Fase 1, depois do Neon.
- Caneca Mágica sem foto: cadastro da loja.
