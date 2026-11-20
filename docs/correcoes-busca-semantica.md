# Correções da busca semântica (revisão do PR #32)

**Data:** 16/11/2026 · **Branch:** `busca-semantica` · **Base:** `30209af` (Gui)

A revisão do PR #32 achou seis defeitos no caminho semântico. As seis correções estão neste commit. Cada item traz o defeito, o efeito para o cliente e o que mudou.

## 1. Sem `tipo_produto`, o catálogo inteiro virava candidato

- **Defeito:** sem tipo, `pontuarCatalogo` aceitava todo produto com vetor. O BM25 exigia casar um termo de conteúdo, e esse corte se perdeu.
- **Efeito:** a busca nunca respondia "não encontrei". Uma consulta sem sentido devolvia 3 produtos quaisquer.
- **Correção:** `PISO_TEXTO_PADRAO = 0.30` (`src/catalogo/semantica.ts`). Sem tipo, o produto entra se o cosseno de texto for ≥ piso **ou** se tiver a etiqueta da ocasião pedida, como no BM25. Com tipo, nada muda: quem admite é o filtro de tipo.
- **Por que a etiqueta admite:** a primeira versão, só com o piso, derrubou o eval 11 (`api_500`, de 3/3 para 0/3). O pedido "produtos disponíveis para natal" não lembra nenhum produto pelo texto, então a busca respondia "não encontrei" sem chamar a API, e o 500 nunca acontecia. Com a etiqueta admitindo, o eval voltou a 3/3.
- **Pendente:** o 0,30 não foi medido, e isso está marcado com `shortcut:` no código. Calibrar com `npm run avaliar:recomendacao -- --comparar --piso-texto <n>` contra o catálogo real.

## 2. O cosseno cru desequilibrava a relevância

- **Defeito:** o BM25 entrava na fórmula normalizado (`score/maxScore`, de 0 a 1). O semântico entrava com o cosseno cru, que fica em ~0,2–0,6 no `text-embedding-3-small`.
- **Efeito:** `PESO_OCASIAO` (0,42) passava a valer mais que `PESO_SIMILARIDADE` (0,5 × cosseno). Um produto irrelevante com etiqueta de ocasião ia à frente do produto certo.
- **Correção:** em `candidatosSemanticos`, a similaridade é dividida pela maior da rodada, como no BM25.

## 3. Produto sem vetor sumia em vez de cair no BM25 (spec §3.6)

- **Defeito:** com o motor ativo, o produto sem linha de vetor era descartado. O BM25 nunca era consultado para ele.
- **Efeito:** um produto novo desde a última geração ficava invisível. Se fosse o único do tipo pedido, a resposta virava `nenhum_do_tipo`.
- **Correção:** a nova função `semNotaSemantica` marca o produto sem vetor e, quando há filtro de tipo, também o produto cujo tipo não tem vetor. Esses produtos passam por `candidatosLexicais` e se juntam aos semânticos. O `nenhum_do_tipo` só sai quando os dois lados estão vazios.

## 4. A falha no vetor de tipo era engolida

- **Defeito:** quando o embedding de um lote de tipos falhava, o tipo saía do arquivo sem entrar nas `falhas` nem na trava de 5%. O vetor de tipo era gravado mesmo quando a trava disparava.
- **Efeito:** o `gerar:vetores` dizia ✓, e quem pedia o tipo afetado recebia `nenhum_do_tipo`.
- **Correção:** `calcularVetoresDeTipo` (`src/catalogo/geracao.ts`) só calcula e roda antes da trava. O produto cujo tipo ficou sem vetor entra em `falhas` como `sem vetor de tipo`. Os três arquivos só são gravados depois da trava.

## 5. Correção de tipo sem vetor e modelo divergente

- **Correção de tipo feita depois da geração:** coberta pelo item 3. O produto vai ao BM25 em vez de sumir.
- **Modelo divergente:** `retrato()` compara o `modelo` gravado nos vetores com o do motor. Se divergirem, loga `modelo_divergente` uma vez por carga e a busca vai ao BM25. O motivo já existia no `logBusca` e nunca era emitido. Vetores de tipo de outro modelo viram `null`, e a busca segue para o `sem_vetores_de_tipo`.

## 6. O `tipo_produto` ia cru para o embedding

- **Defeito:** os tipos do catálogo passam por `canonizarTipo`, mas o tipo vindo do modelo não passava.
- **Efeito:** "Camisetas" e "camiseta" davam cossenos diferentes, e o piso e a margem estão calibrados na forma canônica.
- **Correção:** `canonizarTipo(pedido.tipoProduto)` em `candidatosSemanticos`. O `tipoPedido` devolvido ao agente segue o texto original.

## Testes

- `tests/buscaSemantica.test.ts`: o `montar()` ganhou `semVetorPara`, `modeloVetores` e `tipos`, e o motor passa a declarar `modelo: "falso"`. Casos novos:
  - consulta sem correspondência → `sem_correspondencia`;
  - produto sem vetor → entra pelo BM25;
  - tipo corrigido sem vetor → entra pelo BM25;
  - modelo divergente → BM25 e um log só;
  - "Camisetas" → canonizado;
  - abaixo do piso de texto, a etiqueta da ocasião ainda admite.
- `tests/geracao.test.ts`: tipo sem vetor conta na trava, e nada é gravado.
- O item 2 não tem teste próprio, porque os vetores 0/1 do mock não diferenciam a normalização.
- Vermelho-verde: os 7 testes novos falham com o `src/` anterior e passam com a correção.
- Suíte inteira: 1099 testes verdes, e `tsc --noEmit` limpo.

## Validação

### Evals (mock, suíte inteira, 3 rodadas, antes × depois)

| | Antes (`30209af`) | Depois |
|---|---|---|
| Expectativas | 330 ✓ / 39 ✗ | 327 ✓ / 42 ✗ |

Os cenários que falham são os mesmos nas duas árvores: 04, 06, 17, 39, 40 e 43–46. As diferenças de uma árvore para a outra foram instabilidade do modelo:
- o **05** deu 3/3 antes e 0/3 depois na suíte inteira; rodado de novo sozinho, deu 0/3 nas duas;
- o **16** deu 2/3 antes e 3/3 depois.

As correções não causaram regressão. Os cenários 43–46, que são do próprio PR, já falhavam no commit original. Os sintomas:
- no 45, o modelo não chama `detalhar_produto` com o id do ajuste;
- no 46, a resposta não pergunta a quantidade.

### Catálogo real (spec §8)

- **Geração:** 6624 produtos e 310 tipos, sem nenhuma falha, em 20 min (`npm run gerar:vetores`, índice de 10/11).
- **Medição** (`npm run avaliar:recomendacao -- --comparar --varrer`): as armadilhas no top-3 caíram de 6 no BM25 para 3 na semântica, e nenhum produto existente se perdeu. Os 3 casos que sobram são um **falso alarme**: o regex de armadilha da consulta 36 (`microfone`) casa com as próprias caixas de som com microfone, que são o produto certo. Corrigindo o regex, a semântica fica com 0 armadilhas.
- **Piso 0,60 e margem 0,20:** todas as combinações de piso de 0,35 a 0,75 dão o mesmo resultado, exceto 0,70 sem margem. A calibração do mock se sustenta no catálogo real.
- **Casos conferidos à mão:**
  - 18 "boné": a loja não tem boné avulso, só kits e viseira, então o `nenhum_do_tipo` está certo;
  - 26 "camiseta": a única camiseta do catálogo é a Camisa Dray Fit.
- **Pendente:** a revisão das 40 consultas pelo João, em `Validações/busca-semantica-comparacao.md` (critério de ≥ 80%, spec §2.2).
- **Pendente:** calibrar o piso de texto. O `--comparar` não aplica as etiquetas de ocasião. Por isso a consulta 01 ("brinde de Natal", sem tipo) mostra porta-champagne, porta-copos e babador, que passam do 0,30. No agente, a etiqueta de natal reordena esse resultado.

## Fora daqui

- O mapa de tipos é refeito a cada busca.
- O relatório do `compararBusca` é gravado em `../../Validações`.
- A ordem de gravação `.bin`/`.json` deixa um intervalo curto com vetores trocados.
- O "preço suspeito", do escopo da fase, não foi feito.
- A versão Neon do `VectorStore` e do `TipoStore` (Fase 1, T9).
