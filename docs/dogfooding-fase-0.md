# Dogfooding da Fase 0 (09/11/2026): o que ficou para a Fase 2

Teste real com o número extra, a ponte e o índice v2 migrado. **O preço está certo** em todos os casos testados (Dray Fit 10 e 100 un., Caneca Mágica sob demanda, miniatura de empilhadeira 20 un.), e o `conferir:precos` deu 0 divergências em 303 preços. Os problemas abaixo são da conversa, não do preço, e já existiam antes da Fase 0.

## 1. Busca casa palavra solta (escopo da busca semântica)

| Pedido do cliente | O que veio junto |
|---|---|
| "10 camisas dry fit" / "100 camisas dry fit" | Porta Latas Camisa Personalizado |
| "50 canecas mágicas" | Escova Mágica, Copo de Vidro para Cerveja |
| "200 miniaturas de empilhadeira" (sem estoque para 200) | 3 × Carro Miniatura |

A busca é lexical: basta uma palavra do nome casar. Quando o produto pedido sai por estoque ou mínimo, sobram os vizinhos de palavra, que são de outro tipo.

## 2. Texto da resposta com cartão

- Desde `259975c`/`cf23919`, no turno do `buscar_produtos` o texto é fixo: "Separei esta(s) opção(ões) para você. ..." (o modelo vazava "os cartões já foram enviados" e listava o produto).
- **Efeito colateral:** quando a busca traz outro tipo de produto (item 1), o cliente não fica sabendo. Antes, o prompt mandava dizer "não achei X; achei estes". Com a busca semântica filtrando por tipo, isso perde importância; sem ela, vale o código comparar o tipo pedido com o dos cartões.
- No `detalhar_produto` o texto continua do modelo (os avisos de estoque, mínimo e quantidade dependem dele), só com o filtro `semRepetirCartoes`.

## 3. Escolhas do modelo (gpt-4o-mini)

- **Quantidade inventada:** "me mostra a miniatura de empilhadeira" virou `buscar_produtos` com `quantidade: 1`. Com mínimo 20, a busca respondeu "nenhum produto" + ajuste de 20 un., e o modelo escreveu "não encontrei... posso buscar 20 por R$ 31,27", contraditório. O certo: perguntar a quantidade, ou apresentar o produto com o mínimo.
- **"Quero 200 dessa"** depois de um produto que só apareceu em `ajustes_sugeridos` (sem cartão): o modelo buscou de novo em vez de chamar `detalhar_produto` com o `produto_id` do ajuste. Resultado: carros em vez de "não tem no estoque". O id do ajuste não entra em `ultimasOpcoes`.
- **Cor escolhida sozinha:** no orçamento ("pode fazer o orçamento da última"), o cliente não disse a cor e o modelo pôs Azul royal sem perguntar. Risco já listado antes da Fase 0.
- **Pedido repetido:** pedindo de novo o mesmo produto, o modelo não chama a busca e copia o cartão do histórico (o filtro tira as linhas copiadas).

- **Produto errado com o nome pedido:** "Me mostra a Camisa Dray Fit" detalhou o Porta Latas (que estava no histórico pela busca errada) e o modelo passou a chamá-lo de "camisas dry fit". Some com a busca semântica, mas o modelo não confere nome pedido × nome do produto.
- **Loop "confirma a cor?"** (corrigido): o modelo mandava o id do produto ao `preparar_orcamento`, que recusava mesmo com uma cor só. Agora, com uma cor só ou só uma cobrindo a quantidade, a ferramenta usa essa cor.

## 4. Ponte: lote processado duas vezes (não investigado)

Mensagens enviadas em sequência ("Me mostra a Camisa Dray Fit" e "Quero 25 dessa") viraram um turno cada e, depois, um terceiro turno com as duas juntas. O mesmo padrão deu as 3 respostas iguais no início do dogfooding. Suspeita: reenvio do lote pela ponte.

## 5. Cadastro

- Caneca Mágica (`dd4c5dbf-ab7d-4084-8c2b-e2f7e28669de`) está sem imagem na brinde.me: o cartão vai só como texto.

## Evals que seguem abaixo de 3/3

- `16_lacuna_conhecimento`: 0/3 (falha antiga, escolha de ferramenta).
- `39_orcamento_sem_dados`: 1–2/3 (a guarda no `runTurn` impede o dano).
