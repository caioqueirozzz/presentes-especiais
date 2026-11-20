# Dogfooding — Módulo Design

## Entrega 1 — quadro de design (16/11/2026)

Ambiente: branch `quadro-de-design`, CRM em dev (`localhost:3200`) contra o Postgres do Docker (5440), ponte do WhatsApp com sessão real e Lia desligada, armazém em modo disco. Cliente simulado por um segundo número do time.

### O que passou

- Mensagem do cliente chega ao CRM como lead novo; atribuição ao vendedor de teste.
- Vendedor clica "Enviar para design" num lead sem foto: job `VENDEDOR` em Na fila, selo "Sem imagem", designer atribuído pelo rodízio e notificado ("Novo job de design").
- Designer: Começar (Em criação), mockup v1 anexado e enviado com legenda; o cliente recebe a imagem e a legenda no WhatsApp; job vai para Aguardando cliente.
- Marcar ajustes, v2 anexado e enviado; o quadro mostra v1 e v2.
- "Cliente aprovou" manda o pedido de confirmação com a versão; o texto aparece na conversa do job.
- Cliente responde "ok": não aprova, fica registrado (`resposta_confirmacao`, `aprovou: false`) e o designer recebe "Cliente respondeu, mas não confirmou com APROVO".
- Cliente responde "APROVO": job vai a Aprovado com a v2, `ARTE_FINAL` registrado, conversa devolvida à Lia e o vendedor recebe "Arte aprovada, falta o pedido".
- Designer é redirecionado em `/app/crm` e `/admin/crm`; `/api/reports` e `/api/dashboard` respondem 403.
- Lead movido para a etapa Arte abre um job `PEDIDO` em Na fila, já com designer.

### O que falhou e foi corrigido

- A página do lead caía com "destroy is not a function" no Chromium atual: dois `useEffect` devolviam a Promise do `scrollIntoView`. Corrigido em commit `fix` separado (código anterior ao módulo; o mesmo padrão estava no `IaView`).

### Observações em aberto

- Ao enviar o mockup pela ponte, o agente registra `atendente_assumiu`: é o comportamento da spec (seção 9.1), para a Lia pausar enquanto o designer fala com o cliente. Na entrega 3, conferir que a devolução depois do "APROVO" religa a Lia.
- Depois de uma reconexão que "autenticou mas não ficou pronta", a varredura da ponte falhava em `getChats` e as mensagens não chegavam ao CRM até reiniciar a ponte. Comportamento anterior ao módulo.
- O anexo do mockup foi testado pelo input da tela com arquivo injetado (PNG gerado), não pelo seletor de arquivos do sistema.
- A checagem "Lia não fala por cima" fica para a entrega 3: o índice de catálogo do Docker está vazio e o agente não sobe com a Lia ligada.

## Entrega 2 — kit de partida por IA (16/11/2026)

Ambiente: branch `kit-de-partida-por-ia`, mesmo CRM e banco da entrega 1, `npm run design:worker` com `gpt-4o-mini`. As fotos não passaram pelo WhatsApp: com a Lia desligada a ponte descarta a mídia do cliente antes de baixar, e o agente que guarda os anexos não estava no ar. Cada foto foi enviada pela rota `/api/integracao/design`, a mesma que a ponte usa. Cinco fotos de catálogo de camisa polo (sem dado de cliente), uma por job.

### O que passou

- As 5 viraram job em Processando IA e saíram para Na fila com `IA ok`, designer atribuído, entre 6 e 11 s do envio à fila (cerca de 5 s na chamada ao modelo).
- Peça, gola e manga corretas nas 5; o logo ou texto do peito foi achado nas 5, com o conteúdo certo quando é texto (HUGO, BOSS, AGRONOMIA, "SEU LOGO AQUI!") e "cavalo" para o logo sem texto.
- Evento `ia_ok` com tokens e modelo nas 5: 25.817 tokens de entrada (fixos, por ser uma imagem por job) e de 98 a 143 de saída.
- Chave inválida: `IA falhou` e Na fila na primeira tentativa (401), com o aviso em destaque no log do worker.
- Rede bloqueada para a OpenAI: 3 tentativas, a 2ª cerca de 30 s depois da 1ª e a 3ª cerca de 120 s depois da 2ª; o job termina em `IA falhou` e Na fila (167 s no total).

### O que falhou

- **Marcações (bbox):** erradas nas 5. O modelo devolve números pequenos sem relação com a imagem (ex.: `[0, 0, 100, 100]` numa foto de 768×1024) e a tela desenha as caixas no canto superior esquerdo. O `gpt-4o-mini` não localiza elementos em pixels.
- **Paleta:** o fundo domina. Nas fotos de catálogo o branco do fundo fica com 38% a 71%, e as cores do logo (vermelho da HUGO, verde da AGRONOMIA) somem por ficarem abaixo de 3%. Na foto com modelo, o tom de pele entrou na paleta.
- **Briefing:** começa com "O cliente aprovou..." nas 5, porque as últimas 20 mensagens do lead ainda eram as do teste da entrega 1 (com o "APROVO"). Numa das fotos o modelo inventou uso ("identificar a equipe em eventos"). As mensagens de um job antigo do mesmo lead entram no briefing do job novo.

### Custo

Por job, pelos tokens gravados: 25.817 de entrada e cerca de 120 de saída. Com a tabela pública do `gpt-4o-mini` (US$ 0,15 por milhão de entrada e US$ 0,60 por milhão de saída, a conferir na fatura), dá cerca de US$ 0,004 por job.

### Depois das decisões D12 a D14

O João escolheu esconder as marcações, tirar o fundo da paleta e cortar a conversa no último job fechado. Com as 5 fotos de novo:

- A tela mostra a foto sem caixas; a lista de elementos com a posição em texto segue igual.
- Nas 4 fotos de catálogo o fundo saiu da paleta e a cor da camisa passou a dominar (ex.: preto da BOSS com 79% + 11%). A foto com modelo, sem fundo liso, ficou igual. As cores pequenas do logo continuam de fora, e o k-means agora gasta os 6 grupos em tons próximos da mesma cor.
- Os briefings descrevem só a peça da foto, sem herdar o job anterior.
- Tempo de 6 a 12 s por job; 25.794 tokens de entrada e de 102 a 187 de saída.

## Entrega 3 — Lia encaminha ao design (16/11/2026)

Ambiente: branch `lia-encaminha-ao-design`, agente, ponte, CRM e worker no ar, Lia em modo teste só com o número de teste, `ORCAMENTO_ESCRITA=simulada`. Uma história completa pelo WhatsApp (foto de catálogo da entrega 2) e o caso da logo para caneca, em vez das 5 fotos do plano.

### O que passou

- Foto com a legenda "quero uma camiseta igual essa da foto, sendo que com a logo da minha empresa nela": a Lia chamou `encaminhar_design` (`referencia_uniforme`), o job abriu com origem LIA, o worker montou o kit e o job foi para Na fila.
- Designer: Começar, mockup enviado, "Cliente aprovou". Com o mockup enviado a conversa passou para humano e a Lia ficou quieta.
- "ok" não aprovou e a Lia não respondeu; "APROVO" aprovou, gerou a arte final e devolveu a conversa à Lia; "quanto fica?" foi respondido pela Lia.
- Logo com "quero essa logo gravada em 50 canecas": nenhum job de design aberto nas 3 tentativas. Nas 2 primeiras o caso falhou para o cliente (ver abaixo); na 3ª, depois da correção, a arte foi registrada e a Lia seguiu para o orçamento.

### O que falhou e foi corrigido

- **Referência registrada como arte:** com o nome genérico que o WhatsApp dá ao arquivo (`arquivo-XXXX.jpg`), a Lia registrava a foto de referência como arte do cliente (5 de 5 numa conversa limpa). O eval 42 só passava porque o arquivo se chamava `uniforme-referencia.jpg`. Frase nova no prompt com OK do João, eval 42 com nome genérico e eval 42b com a frase real; A/B em 3/3 nos 10 cenários.
- **Nome de arquivo inventado no `registrar_arte`:** no caso da caneca a Lia passou `logo-empresa.jpg` em vez de `arquivo-B8DCF53F.jpg`, a ferramenta não achou o arquivo e a Lia disse ao cliente que a logo não chegou (2 tentativas). Anterior ao módulo. Agora, com um só arquivo na última mensagem do cliente, o `registrar_arte` usa esse arquivo quando o nome não bate.
- **Arte apagada no mesmo turno:** a Lia chamava `registrar_arte` e logo depois `iniciar_novo_pedido`, que zerava as artes (3 de 6 numa sondagem). Anterior ao módulo. Agora o pedido novo mantém a arte que veio na mensagem atual; 6 de 6 na mesma sondagem.
- **APROVO entregue à Lia:** o "APROVO" aprovava o job, devolvia a conversa e depois era entregue à Lia, que abria um job de design novo. Agora o CRM manda na devolução o id da mensagem consumida e a ponte não a entrega. Revalidado ao vivo: nenhum job novo e a Lia só respondeu a mensagem seguinte.

### Observações em aberto

- Ao ligar a Lia, a ponte entregou de uma vez mensagens paradas de horas antes ("ok", "APROVO" do teste da tarde), e a Lia agiu sobre elas. Comportamento anterior ao módulo.
- `encaminhar_design` manda todos os arquivos que a conversa já recebeu (spec 9.3). No teste foi junto uma foto pessoal antiga do número de teste, que também foi à OpenAI no kit. Vale decidir se vão só os arquivos recentes.
- A Lia não repete a mensagem exata da ferramenta depois de encaminhar; reescreve com as palavras dela.
- No "quanto fica?" a Lia chamou `preparar_orcamento` com um `subproduto_id` inventado. Comportamento anterior ao módulo.
- O eval 44 (ajuste de mockup) oscilou entre 2/3 e 3/3: na rodada que falha a Lia transfere com `ajuste_mockup`, o que também abre o job de design.

## Revisão final da branch (17/11/2026)

Revisor novo sobre os 36 commits, contra a spec e o plano. Nenhum achado crítico; os 5 pontos de risco do plano se confirmaram no código. Corrigidos, cada um com teste que falhou antes:

- **I1:** quando a aprovação grava mas a ponte falha na devolução, o job fechado mostra o botão "Devolver" (antes o aviso mandava usar um botão que não existia e a Lia ficava pausada).
- **I2:** o designer vê os jobs sem dono para assumir (D15).
- **I3:** arquivo inválido é pulado em vez de derrubar o lote; vão os 10 mais recentes; SVG com comentário ou DOCTYPE e PDF com bytes antes do cabeçalho são reconhecidos (D16).
- **I4:** a mesma imagem não entra de novo no job nem dispara outra análise (D16).
- **I5:** um "APROVO" escrito antes do pedido de confirmação e entregue com atraso não aprova (30 s de folga para o relógio).
- **M6:** a aprovação só adianta o pedido que está em Confirmado ou Arte; pedido já em produção ou depois não volta.
- **M7:** a paleta trata a transparência do PNG como branco; antes o preto do logo saía junto com o fundo.

Testes do CRM com usuários de `created_at` crescente e esperas medidas pelo relógio do banco (dois testes eram intermitentes). CRM: 110 testes, 3 rodadas no pglite e 2 no Postgres do Docker; agente: 90 arquivos.

Ficaram para depois (menores): dois workers ao mesmo tempo pegam o mesmo job; desempate de `created_at` dos arquivos; Content-Disposition no R2; envio de mockup duplicado por clique duplo; avisos sem designer não caem nos admins; `requested_by` inexistente dá 500; URL assinada pode ir ao log da ponte; tamanho do arquivo conferido só depois de lido.
