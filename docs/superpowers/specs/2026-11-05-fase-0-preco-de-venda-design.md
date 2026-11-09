# Fase 0: preço de venda do site no agente

> Status: spec aprovada no brainstorming de 04–05/11/2026 (João). Implementação ainda não começou.
> Branch: `preco-de-venda-do-site`, sobre `restaura-correcoes-do-dogfooding` (`ca9937a`).
> ClickUp: "Integrar o agente à API da loja" (prazo 10/11) e "Organizar o conhecimento e a recomendação de produtos" (prazo 11/11).

## 1. Por que esta fase existe

O agente cota a tabela `subproducts[].prices` da API oficial (`api.brinde.me`). Essa tabela é o **preço de custo**. O preço que o cliente paga é o do site `presentesespeciais.com.br`, que a brinde.me calcula por cima do custo.

Exemplo real (Camisa Dray Fit, PE001, 04/11):

| Quantidade | API (custo, o que o agente cota hoje) | Site (venda) |
|---|---|---|
| 10 | R$ 18,00 | R$ 42,41 |
| 100 | R$ 16,00 | R$ 37,84 |
| 25 | sem faixa | a consultar |

Cotar abaixo do site dá prejuízo à loja e desgasta a relação da DC Tech com ela. Das três hipóteses da task do ClickUp (cadastro errado, extração do preço errado, instabilidade da brinde.me), a certa é a segunda.

## 2. Regra que não pode ser quebrada

> **Todo preço que chega ao cliente é o que o site mostra naquele momento, para aquela cor (`subproduto_id`) e aquela quantidade exatas.**

- O índice local e o agrupamento de cores servem **só para buscar, filtrar e ordenar**. Nunca são a fonte de um preço mostrado ao cliente.
- O preço que vai ao cliente é **montado pelo código**, nunca redigitado pelo modelo (seção 6).
- Se não for possível obter o preço exato, o produto aparece **sem preço**, e fechar o pedido vai para um humano. **Nunca** se mostra o custo nem um preço do índice.

## 3. Decisões tomadas (não reabrir)

1. **A fonte do preço de venda é a rota da vitrine** `GET https://app3.brinde.me/api/subproduct/{subproduto_id}/price/{q1,q2,...}?domain=presentesespeciais.com.br`, com o cabeçalho `domain: presentesespeciais.com.br`. Ela não é documentada, mas é a que o próprio site chama. **Não existe rota oficial de preço de venda**: esta é a fonte definitiva. A API oficial não tem preço de venda no produto, e os webhooks da brinde.me não têm evento de produto.
2. **O valor do custo é descartado na entrada.** Das faixas da API ficam só os **limites de quantidade** (`init_quantity`/`final_quantity`), que servem de mapa de quais quantidades consultar. O valor do custo serve apenas como chave de agrupamento, em memória e dentro do sync. Ele não é gravado, não é mostrado e não entra em conta nenhuma.
3. **Abordagem C:** o cliente da brinde.me passa a devolver as **faixas de venda** em `Subproduct.prices`. O resto do código continua lendo `prices`.
4. **Índice local já com o preço de venda** (versão 2). O banco vem na Fase 1 (o Neon do Dudu, o mesmo do CRM) e só troca o destino.
5. **Validade do preço exato: 1 hora.** Passou disso, ou mudou a cor ou a quantidade, a consulta é refeita.
6. **Rota falhou:** o produto aparece sem preço ("valor a confirmar com a equipe"), e fechar o pedido vai para um humano.
7. **Condição para mais unidades:** mostrar só o **próximo degrau mais barato** acima da quantidade pedida ("a partir de N un.: R$ X/un"). Sem degrau mais barato, dizer que para quantidades maiores a equipe faz uma condição especial, e transferir para humano se o cliente quiser.
8. **Sync de preços:** um job noturno separado do processo do agente, mais o comando manual `npm run sync:precos` para a primeira carga e para emergências. Webhook não serve.
9. **Mensagem de recomendação no formato pedido pelo Dudu** (ClickUp, 04/11): uma mensagem por produto, com **foto** e legenda trazendo nome, cores disponíveis, preço unitário e condição para mais unidades. **Sem SKU e sem quantidade mínima.**
10. **Sob demanda:** só os 2 produtos próprios da loja, numa lista local no repo (nada é criado na brinde.me):
    - Camisa Dray Fit: `afc89ae2-d187-405a-b826-d2e2ae0447f5`
    - Caneca Mágica: `dd4c5dbf-ab7d-4084-8c2b-e2f7e28669de`

    Para eles o estoque é ignorado, e qualquer quantidade a partir do mínimo é aceita. Para todo o resto, estoque 0 ou insuficiente faz o agente dizer que não tem no estoque e oferecer o atendimento humano para confirmar.
11. **Produção nunca usa mock nem cai em modo degradado sem avisar** (seção 8).

## 4. Evidência que sustenta o desenho (sonda de 05/11)

Foram 45 produtos sorteados, 153 cores e ~2,6 mil pares quantidade/preço, com as faixas lidas ao vivo da API oficial e o preço lido da rota da vitrine.

- **Cores com as mesmas faixas de custo (limites e valor) têm o mesmo preço de venda:** 45 de 45 grupos. Cores com faixas diferentes tiveram preço diferente em 16 de 16 pares. Limites iguais com custo diferente dão preço diferente: na caneta balcão, a roxa custa 221 centavos contra 230 das outras cores, e sai por 774 contra 792.
- **O 0 ("a consultar") cai exatamente onde não existe faixa de custo:** 2.656 de 2.656 pontos.
- **Degraus:** numa varredura densa de 8 produtos, o preço só mudou nos limites das faixas de custo e em **100, 500, 1000 e 5000**. As quedas foram de ~2%, ~1%, ~1% e ~1%, com variação de ±0,2% por arredondamento.
- **O fator venda/custo não é fixo:** vai de 2,15× (custo de R$ 103) a 7,4× (custo de R$ 0,48). **Não tente reproduzir a conta.**
- **Foto:** o `.webp` do CDN (`cdn.brinde.me`) enviado com `MessageMedia.fromUrl(url, { unsafeMime: true })` e `sendMessage(chat, midia, { caption })` chega como **foto**, com a legenda inteira, no `whatsapp-web.js` fixado (`064a3d5`). `sendMediaAsDocument` com webp foi "enviado" e **não chegou**: não use.

## 5. Peças

### 5.1 `src/integrations/brindeme/precoVenda.ts` (novo)

- A função `consultarPrecoVenda(subprodutoId, quantidades[])` chama a rota da seção 3.1 e devolve `Map<quantidade, centavos>`. O 0 é mantido como 0 e significa "a consultar".
- Manda no máximo 60 quantidades por chamada; acima disso, divide em lotes.
- **Erros tipados** (`ErroPrecoVenda` com `motivo`):
  - `timeout`: 5 s;
  - `rede`: tenta mais uma vez em erro de rede ou 5xx;
  - `limite`: em 429, espera o `Retry-After` (padrão de 10 s) e tenta até 3 vezes;
  - `formato`: resposta que não é JSON, 404 em HTML ou quantidade pedida ausente em `prices`.
- **Disjuntor próprio:** uma segunda instância de `CircuitBreaker` (`src/integrations/brindeme/circuitBreaker.ts`, a classe aceita opções no construtor), separada da instância da API oficial. Depois de 5 falhas seguidas, abre por 2 min e falha na hora com `indisponivel`.
- Loga cada chamada no mesmo padrão do `apiLogger.ts`.

### 5.2 Pontos de consulta e montagem das faixas de venda (`src/catalogo/faixasDeVenda.ts`, novo, puro)

Para um grupo de cores com os limites `L = [{min, max}]` e o mínimo do produto `m`:

1. **Pontos:** `P = {m} ∪ {f.min, f.max + 1 para cada f em L, só se f.max < 1_000_000} ∪ {100, 500, 1000, 5000}`, mantendo apenas `q ≥ m`, em ordem.
2. Consultar `P` na rota.
3. **Faixas de venda:** para pontos consecutivos `p_i < p_{i+1}`, a faixa `[p_i, p_{i+1} − 1]` recebe o preço `v(p_i)`. O último ponto vai até o `max` da faixa de custo que o contém. Faixas com `v = 0` **não entram**, porque nelas não há preço e vale "a consultar". Faixas vizinhas com o mesmo preço se fundem.
4. Saída: `PriceRange[]` em reais (`arredondar(centavos / 100)`), no mesmo formato de hoje.
5. **Próximo degrau** de uma quantidade `q`: o menor início de faixa de venda maior que `q` com preço menor que o de `q`. É só uma candidata: o preço mostrado sai da consulta exata (5.4).

Fixture obrigatório (Dray Fit, números reais): 10–18 a R$ 42,41; 19 a R$ 40,51; 20–50 sem faixa; 51–99 a R$ 38,61; 100 a R$ 37,84; 101+ sem faixa.

### 5.3 `src/integrations/brindeme/clienteComPrecoDeVenda.ts` (novo)

- Classe que implementa `BrindeMeClient` e embrulha o `HttpBrindeMeClient`. Ligada em `factory.ts` quando `BRINDEME_MODE=http`.
- `getProduct(id)`:
  1. chama o cliente de dentro;
  2. agrupa as cores ativas pelos limites e pelo valor do custo (a chave só existe em memória);
  3. para cada grupo, consulta os pontos de 5.2 com **um** `subproduto_id` do grupo;
  4. grava em `prices` de cada cor as faixas de venda do grupo, e grava `limites` (`[{min, max}]`) e `grupo_preco` (hash curto da chave, sem o valor legível);
  5. **descarta o custo**.
- Grupo cuja consulta falhou: `prices = []` e `preco_indisponivel = true` nas cores dele.
- Os outros métodos repassam sem mudança.
- No modo mock, nada disso roda: os preços dos fixtures valem como preço de venda.

### 5.4 Cotação exata ao vivo (`src/catalogo/cotacao.ts`, novo)

- `cotarAoVivo(itens: Array<{subprodutoId, quantidade, proximoDegrau?}>)` faz **uma chamada por cor**, nunca por grupo, pedindo `quantidade` e `proximoDegrau` na mesma chamada. Vai em paralelo, no máximo 6 de cada vez.
- O resultado por cor é `Cotacao = { subproduto_id, quantidade, centavos, proximo?: { quantidade, centavos }, fonte: "site", em: ISO }`. Com `centavos = 0`, a cor fica "a consultar".
- As cotações ficam no estado da conversa (`state.cotacoes`, chave `subproduto_id + quantidade`), para o `preparar_orcamento` reaproveitar.

### 5.5 Tipos e remoções

- `Subproduct` ganha `limites?`, `grupo_preco?` e `preco_indisponivel?`. `prices` passa a ser o preço de venda.
- **Remover `Product.price`** e todo uso dele: o fallback `range?.price ?? p.price` em `src/tools/prepararOrcamento.ts:142` e em `src/integrations/brindeme/mockClient.ts:118`, e o `money(raw.price)` de `mappers.ts:156`. Sem faixa, vale "a consultar".
- Nenhum mapeamento lê o campo `cost` do item de orçamento.
- `VERSAO_INDICE` em `src/catalogo/indice.ts:34` vai de 1 para 2. O `SubprodutoIndexado` guarda `faixas` (preço de venda), `limites`, `grupo_preco` e `faixas_venda_em`.

### 5.6 Sob demanda (`src/knowledge/sob-demanda.json`, novo)

```json
{ "produtos": [
  { "id": "afc89ae2-d187-405a-b826-d2e2ae0447f5", "nome": "Camisa Dray Fit" },
  { "id": "dd4c5dbf-ab7d-4084-8c2b-e2f7e28669de", "nome": "Caneca Mágica" }
] }
```

Lida por `oferta.ts`, `prepararOrcamento.ts`, `detalharProduto.ts` e `verificacao.ts`. Na partida, cada id é conferido no índice; um id que não existe gera aviso no log, sem derrubar o agente.

### 5.7 Sync de preços (`scripts/syncPrecos.ts`, novo; `npm run sync:precos`)

- Para cada grupo (`produto` + `grupo_preco`) do índice, recalcula as faixas de venda a partir dos `limites` guardados, sem chamar a API oficial. Roda com 3 chamadas simultâneas até a sonda de ritmo (9.3) medir o limite da rota; o valor medido substitui esse.
- Grupo que falha mantém as faixas anteriores e entra em `falhas`. **Se mais de 5% dos grupos falharem, não grava nada** e sai com código 1, deixando alerta no log.
- A gravação é atômica, usando o tmp + rename que já existe em `FileProductIndexStore`.
- **`--migrar`:** lê o índice v1 (`data/produtos-index.json`, `versao: 1`). Agrupa pelas faixas de custo de lá, consulta, monta a v2, descarta o custo e grava a v2 só quando estiver completa. O agente pode continuar ligado durante a migração.
- `sync:catalogo` (`indice.ts:250`): o `getProduct` dele já vem embrulhado. Um produto cuja consulta de preço falhar conta como falha de detalhe e mantém o registro anterior. Nunca grava produto com faixas vazias por falha.

## 6. Fluxo

1. **Busca e filtro** (`recomendar.ts`): mínimo, estoque (respeitando a lista sob demanda), orçamento e ordem sobre o índice v2. Igual a hoje, agora com o preço de venda.
2. **Reconferência** (`recomendar.ts`, o laço que chama `getProduct`): igual a hoje, com o cliente embrulhado.
3. **Cotação exata** dos itens finais: até 3 produtos e, em cada um, até 6 cores que atendem ao estoque.
   - O orçamento do cliente é conferido de novo com o preço exato. Se estourar, o item sai e entra o próximo candidato aprovado.
   - Cor "a consultar" ou que falhou fica sem preço.
4. **Cartões montados pelo código:** `buscar_produtos` devolve, para cada produto, um `cartao = { imagem_url | null, legenda }`. A legenda leva:
   - nome;
   - todas as cores disponíveis;
   - o preço: um só se todas as cores conferidas custam o mesmo, ou cor a cor se não;
   - a condição para mais unidades (decisão 7).

   Cores além das 6 conferidas aparecem pelo nome, com "valor confirmo quando escolher". O runtime (`src/api/agenteDefinitivo.ts`, onde hoje se monta `respostas` a partir de `formatarParaWhatsApp`) envia os cartões do turno como itens de imagem, **antes** do texto do modelo. O prompt manda o modelo não repetir nome, preço nem cores dos cartões, só apresentar e perguntar.
5. **`detalhar_produto`:** cotação exata da quantidade informada, no mesmo formato de cartão.
6. **`preparar_orcamento`:**
   - usa a cotação de `state.cotacoes` se for a mesma cor e a mesma quantidade, tiver `fonte: "site"` e menos de 1 h. Fora disso, cota de novo;
   - um preço com outra fonte é recusado;
   - sem preço, devolve `erro: "preco_indisponivel"` com a instrução de transferir;
   - o `resumo_para_cliente` e a ficha saem com o preço exato.
7. **Autocorreção:** se a cotação exata divergir do índice, vale a exata. O grupo é corrigido no índice e o log registra `preco_divergente` (com produto, grupo, quantidade, índice e site).
8. **Estoque:**
   - um produto fora da lista sob demanda, pedido pelo nome (detalhe ou orçamento) e sem estoque bastante, faz o agente dizer que não tem no estoque e oferecer o humano;
   - na busca, sai da lista. Se **todos** os resultados estiverem sem estoque, o agente diz isso e oferece o humano.

### 6.1 Contrato, ponte e CRM

- `src/contrato/esquemas.ts:34`: `respostas` vira um array de `string | { imagem_url: string, legenda: string }`. A entrega parcial em `ponte.ts:381` compara os itens por igualdade estrutural, não por `===`.
- `src/whatsapp/sessao.ts`: novo `enviarImagem(chatId, url, legenda)` com `MessageMedia.fromUrl(url, { unsafeMime: true })` e `{ caption, sendSeen: false }`. Se lançar erro, `envio.ts` manda a legenda como texto.
- `src/whatsapp/crm.ts` e o CRM (`crm/src/lib/ingest.ts`): o eco da mensagem com imagem é registrado com a legenda e a URL.

## 7. Erros e falhas (resumo)

| Situação | Comportamento |
|---|---|
| A rota falha na conversa | Produto sem preço; `preparar_orcamento` devolve `preco_indisponivel` e manda transferir. Nunca usa índice nem custo |
| Disjuntor aberto | O mesmo, sem esperar timeout |
| 429 | Espera `Retry-After` e tenta até 3 vezes |
| Cotação diverge do índice | Vale a cotação; o índice é corrigido e registrado como `preco_divergente` |
| Falha de grupo no sync | Mantém o anterior; acima de 5% de falha, não grava nada |
| A foto falha ao enviar | A legenda vai como texto |
| Id da lista sob demanda inexistente | Aviso na partida |

## 8. Ambiente: produção nunca cai em mock ou degradado sem avisar

- `src/config.ts:36`: `BRINDEME_MODE` **perde o padrão `"mock"`**. Sem ele, o agente não sobe.
- Todo ponto de partida (`src/api/index.ts`, `src/whatsapp/index.ts`, `src/lancador.ts`, `src/duble/index.ts` no modo `direto`) chama `verificarAmbiente(process.env, fatos, { producao })` (`src/operacao/verificacaoAmbiente.ts`) e **sai com código 1** se houver erro.
  - `producao` é `true` por padrão. Só `AMBIENTE=dev` no `.env` relaxa a verificação.
- Erros novos em produção:
  - CRM desligado (`CRM_URL` vazio ou `CRM_INTEGRATION_SECRET` com menos de 16 caracteres) sem `CRM=desligado` explícito;
  - `BRINDEME_MODE` ausente.
- Ficam para a Fase 1: as pastas `data/...` em disco efêmero da nuvem, `IA_MODEL` com padrão no CRM e `PONTE_URL` com padrão `127.0.0.1` no CRM.
- `ORCAMENTO_ESCRITA=simulada` é proposital (R5 do PET: orçamento quem emite é pessoa) e não muda.

## 9. Testes e validação

### 9.1 Testes automáticos (vitest, `--maxWorkers=1`)

- **`precoVenda`:**
  - casos: 200, 0, 404 em HTML, resposta que não é JSON, 429 com `Retry-After`, timeout e quantidade faltando;
  - confere o cabeçalho `domain` e o disjuntor abrindo e fechando.
- **`faixasDeVenda`:**
  - fixture da Dray Fit (5.2);
  - caneta com faixa única e degraus em 100, 500, 1000 e 5000;
  - fusão de faixas vizinhas iguais, e faixa com 0 omitida;
  - **nenhum valor de custo na saída**.
- **`clienteComPrecoDeVenda`:**
  - uma chamada por grupo;
  - a caneta roxa fica em grupo separado das outras cores;
  - a falha de grupo marca `preco_indisponivel`;
  - o objeto devolvido não contém custo.
- **`cotacao`:**
  - uma chamada por cor;
  - próximo degrau na mesma chamada;
  - o orçamento é conferido de novo com o preço exato, e o item que estoura sai;
  - preço igual em todas as cores dá um preço só.
- **`preparar_orcamento`:**
  - recusa preço que não seja `fonte: "site"`;
  - cota de novo com mais de 1 h ou com outra cor ou quantidade;
  - devolve `preco_indisponivel` com a instrução de transferir.
- **Estoque:**
  - os 2 produtos sob demanda passam com estoque 0 e qualquer quantidade a partir do mínimo;
  - os outros, sem estoque, oferecem humano, inclusive na busca em que todos os resultados estão sem estoque;
  - `verificacao.ts` concorda com `oferta.ts`.
- **`syncPrecos`:**
  - `--migrar` da v1 para a v2 sem custo;
  - acima de 5% de falha, não grava;
  - um grupo que falha mantém o anterior;
  - a gravação é atômica.
- **Contrato, ponte e CRM:**
  - o item de imagem passa no schema;
  - `enviarImagem` usa `fromUrl` com `sendSeen: false`;
  - erro no envio da imagem faz a legenda ir como texto;
  - a entrega parcial funciona com itens de imagem;
  - o CRM registra o eco;
  - a legenda não traz SKU nem mínimo.
- **Ambiente:**
  - sem `BRINDEME_MODE`, não sobe;
  - mock ou CRM desligado sem `CRM=desligado` dão erro em produção;
  - com `AMBIENTE=dev`, esses casos passam como aviso.

### 9.2 Evals (mock, com os preços dos fixtures como preço de venda)

- **A/B:** rodar os evals completos **antes** de mudar o código e **depois**, 3 rodadas de `gpt-4o-mini` sobre os 237. O critério é ficar igual ou acima do resultado de antes. (Lição de 25/10: uma única linha de prompt derrubou um eval de 10/10 para 5/10.)
- **Cenários novos:**
  - produto sob demanda;
  - sem estoque, oferecendo humano;
  - próximo degrau mais barato;
  - sem degrau mais barato;
  - preço indisponível;
  - orçamento com cotação vencida;
  - o modelo não redigita o preço dos cartões.

### 9.3 Validação com dado real (critério de aceite)

- **`npm run conferir:precos` (script novo):**
  - sorteia 100 produtos reais com semente fixa, sempre incluindo a Dray Fit e a Caneca Mágica;
  - usa quantidades aleatórias que incluem os limites e 100/500/1000/5000;
  - pede o preço às ferramentas do agente (`detalhar_produto` e `preparar_orcamento`, que não emite) e compara com a rota da vitrine;
  - **tem que dar 100% igual. A tolerância é zero.**
- **Conferência do índice:** numa amostra, nenhum preço guardado é igual ao custo da API ao vivo.
- **10 produtos no navegador** (Claude Desktop): a página do site contra a mensagem do agente.
- **Dogfooding refeito no número extra,** com a ponte real:
  - Dray Fit com 10, 25 e 100 un.;
  - Caneca Mágica com 50 un. (estoque 0, sob demanda);
  - um produto de fornecedor sem estoque, que tem que oferecer humano;
  - a foto chegando;
  - o filtro de orçamento;
  - a rota derrubada à força, que tem que dar produto sem preço e transferência.
- **Sonda de ritmo da rota `app3`:** a brinde.me não informa o limite de chamadas, então medimos a mão. A sonda sobe o ritmo de chamadas aos poucos até aparecer 429 ou erro, e para aí. O limite medido vai para o relatório e define o ritmo do `sync:precos` e da cotação ao vivo.
- **Migração de verdade:** o tempo e as falhas do `sync:precos --migrar` vão para o relatório.

### 9.4 Pronto quando

- o typecheck e todos os testes passam;
- os evals ficam iguais ou acima do resultado de antes;
- o `conferir:precos` dá 100%;
- o checklist de dogfooding passa sem nenhum preço diferente do site.

## 10. Fora do escopo

- Banco no Neon (o mesmo do CRM, não o Supabase), job agendado na nuvem e disco persistente: Fase 1. Aqui o job noturno é só o `sync:precos` rodando onde o agente roda.
- Busca semântica e o eval de ~40 consultas: Fase 2 (Gui).
- Emitir orçamento pela API: fora do escopo do projeto (R5).
- Reproduzir a fórmula de preço da brinde.me.

## 11. Riscos abertos

Não há pendência com a loja: não existe rota oficial de preço de venda, e o limite de chamadas da `app3` é medido pela sonda de ritmo (9.3).

- A rota `app3` pode mudar sem aviso. A mitigação é o disjuntor, o "produto sem preço" e a trava de 5% no sync.
- A biblioteca do WhatsApp confirmou um envio (documento) que não chegou, e o fallback de texto não pega esse caso.
