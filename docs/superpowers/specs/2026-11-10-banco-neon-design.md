# Banco no Neon: design

**Data:** 10/11/2026 · **Implementa e revisa:** João · **Branch:** `banco-neon`, a partir de `preco-de-venda-do-site`
**Base:** Fase 0 (preço do site) e a spec da busca semântica (`2026-11-09-busca-semantica-design.md`, seção 9), que o Gui implementa em paralelo.

## 1. Problema

Todo o estado do agente fica em arquivos em `data/`: conversas, estado da ponte, lacunas, orçamentos de teste, índice de pedidos e índice do catálogo. O agente ainda não vai para a nuvem, mas vai quando estiver pronto e sem erros, e arquivo local não serve lá. O CRM do Dudu já usa um Postgres no Neon. A decisão de 06/11 era ter um banco só. **Revista em 11/11:** o agente fica num projeto Neon próprio, separado do CRM. No Neon, o dono do banco (`neondb_owner`) é membro de `pg_read_all_data` e `pg_write_all_data`, e essa permissão não pode ser revogada. Num banco só, quem tivesse a credencial do CRM leria e alteraria as conversas e o estado do agente.

## 2. Objetivo e critérios de aceite

Com `AGENTE_DATABASE_URL` apontando para um Postgres (Docker em dev, Neon fora dele), o agente roda sem ler nem gravar dado em `data/`. As exceções são a sessão do WhatsApp (`data/whatsapp-sessao`), as mídias (`data/artes/`) e os logs.

A fase está pronta quando **todos** passarem:

1. Nenhum store em arquivo sobra no código para os dados da seção 3. Ficam só as versões `Pg*` e `Memory*`.
2. Os testes atuais passam, e cada interface tem uma suíte de contrato que roda contra `Memory*` e contra `Pg*` (pglite).
3. Os evals passam como antes (eles usam a loja mock e os stores em memória).
4. Teste de fumaça contra o Docker: ponte + API, uma conversa, os dois processos reiniciados no meio, e a conversa, o modo e os eventos pendentes voltam como estavam.
5. O usuário `agente` não lê nada fora do schema `agente`, e o usuário do CRM não lê o schema `agente`. Isso é conferido por SQL no Docker, com os mesmos papéis do Neon. Em produção, o segundo sentido vem do projeto Neon separado (11/11).
6. Nenhum log imprime a URL do banco, parâmetros de consulta ou conteúdo de conversa.

## 3. O que vai para onde

| Hoje | Tabela | Forma |
|---|---|---|
| `data/conversas/<tel>.json` | `agente.conversas` | `telefone` PK, `doc` JSONB (o `Conversa` inteiro), `atualizado_em`. O schema zod atual valida na leitura; os cortes `MAX_*` continuam no `salvar`. |
| `data/ponte-estado.json` | `agente.estado_ponte` | Uma linha (`id = 1`), `doc` JSONB com o `EstadoPonte`. |
| `data/lia-modo.json` | `agente.estado_ponte` | Campo `modo_lia` na mesma linha. |
| `data/lacunas.jsonl` | `agente.lacunas` | Uma linha por lacuna, com o texto já mascarado por `criarLacuna` como hoje. |
| `data/orcamentos-teste.json` | `agente.orcamentos_teste` | Uma linha por orçamento, com `telefone` e `criado_em` em coluna para a retenção. |
| `data/pedidos-index.json` (PII) | `agente.pedidos` | Colunas do `PedidoIndexado`. Só o `sync:pedidos` grava, e ele continua sem poder rodar. |
| `data/produtos-index.json` | `agente.produtos`, `agente.preco_grupos`, `agente.catalogo_estado` | Produto e grupos de preço; `catalogo_estado` guarda `sincronizado_em`, `completo` e `versao`. |
| Tipos e vetores (Gui) | `agente.tipos_produto`, `agente.vetores_produto`, `agente.vetores_tipo` | `vector(1536)` (pgvector), normalizados. Ficam atrás de `TipoStore` e `VectorStore`. |

**Ficam no repo, fora do banco:** `src/knowledge/etiquetas-ocasiao.json`, `src/knowledge/ocasioes.json` e o `tipos-corrigidos.json` do Gui. São conhecimento curado e revisado em PR, não dado gerado. O `OccasionTagStore` continua lendo arquivo. (Isso substitui o item "etiquetas de ocasião" da lista de migrations da nota do cofre.)

## 4. Camada de banco (`src/db/`)

- No mesmo molde do `crm/src/lib/db.ts`: `query`, `one` e `transaction`. Não importa nada do `crm/`, que é do Dudu e tem build próprio.
- Dependências novas na raiz, nas versões do CRM: `pg` 8.16.3 e `@electric-sql/pglite` 0.3.14 (este só em `devDependencies`, para os testes). Os tipos do `pg` também.
- `AGENTE_DATABASE_URL` com `postgres://`: driver `pg`, pool com `max: 5`, NUMERIC e BIGINT como `number`.
- Nos testes, uma fábrica abre o pglite em memória com a extensão `vector` e aplica as migrations. Os testes não usam variável de ambiente nem Docker.
- Na partida, se a URL não for `localhost`/`127.0.0.1` e não trouxer `sslmode=require`, o processo não sobe e diz por quê.
- Se o banco não responder na partida, o processo não sobe. No meio de um turno, o erro do banco é uma falha do turno como as de hoje: a 2ª falha seguida do mesmo lote transfere para humano pela regra que já existe. Não há fallback para arquivo.
- Erro de banco vai para o log só com `code` e `message`, nunca com os parâmetros.

### 4.1 Migrations

- Ficam em `db/migrations/NNN_nome.sql`, todas com `IF NOT EXISTS`, todas dentro do schema `agente`. O controle fica em `agente.schema_migrations`.
- `npm run db:migrate` aplica na URL do `.env`. O runner só lê `db/migrations/` da raiz e nunca o diretório do CRM.
- `001_inicial.sql`: schema `agente`, extensão `vector`, `schema_migrations`, conversas, conversas corrompidas, estado da ponte, lacunas, orçamentos de teste e pedidos.
- `002_catalogo.sql`: produtos, grupos de preço, estado do catálogo, tipos e vetores.

### 4.2 Papéis e segurança

- `db/papel-agente.sql` é rodado **uma vez pelo dono do Neon (o Dudu)**, nunca por nós. Ele:
  - cria o usuário `agente`, dono do schema `agente`;
  - revoga do `agente` o acesso ao schema `public` (as tabelas do CRM);
  - revoga do usuário do CRM o acesso ao schema `agente`.
- Desde 11/11, o script roda no projeto Neon do agente, e não no do CRM. A credencial de dono desse projeto não vai para nenhum servidor: o agente conecta só como `agente`.
- O agente não toca nas tabelas do CRM. A ponte fala com o CRM só por HTTP (`/api/integracao/*`), como hoje.
- A `AGENTE_DATABASE_URL` fica só no `.env` da raiz, separada da `DATABASE_URL` do CRM. O `.env.example` traz só o formato.
- O Docker de dev cria os dois papéis (`agente` e um `crm` de teste) para o critério 5 ser conferido localmente.

### 4.3 Dev

- `docker-compose.yml` na raiz com a imagem `pgvector/pgvector:pg17`, porta `5440` (a `5439` é do demo do DC Lab), `mem_limit: 256m` e volume nomeado.
- O Docker é o banco de dev, não algo temporário. Fora do dev só muda a URL: Neon na máquina do chip e depois na nuvem, sem nada local.

## 5. Stores assíncronos

- As interfaces passam a devolver `Promise`: `carregar`/`salvar` (índice, pedidos, ponte, conversas), `existe` (conversas) e `registrar`/`listar` (lacunas).
- Cada interface fica com `Pg*` e `Memory*`. As versões `File*` saem, junto com as chaves de `config.ts` que apontam para arquivo (`conversasDir`, `estadoArquivo`, `modoLiaArquivo`, `orcamentosTesteArquivo` e os caminhos dos índices).
- Os chamadores (~20 arquivos) ganham `await`. Uma função que hoje chama `carregar()` por dentro passa a receber o dado carregado ou vira `async`, o que for menor naquele ponto.
- **Conversas:** uma linha por telefone, gravada com `INSERT ... ON CONFLICT (telefone) DO UPDATE`. A ordem por telefone continua garantida pela fila que já existe na API, que roda num processo só. Rodar 2 instâncias da API exigiria lock por linha (`SELECT ... FOR UPDATE`), e isso fica para o deploy.
- **Conversa corrompida** (o zod recusa): hoje o arquivo é separado e começa uma conversa nova. No banco, o `doc` antigo vai para `agente.conversas_corrompidas` (telefone, doc, erro, data), com o mesmo alerta de log, e começa uma conversa nova.
- **Catálogo em memória:** o `IndiceCatalogo` é carregado na partida, e a busca recebe a referência pronta (o contrato combinado com o Gui na spec dele). A cada 5 min, a API lê `agente.catalogo_estado.sincronizado_em`. Se mudou, recarrega o índice e troca a referência de uma vez.

## 6. Sync

- **`sync:catalogo` incremental:** busca só os produtos com `updated_at` mais novo que o gravado e grava por lote, uma transação por lote. Ao fim, atualiza `catalogo_estado.sincronizado_em`. O sync completo continua disponível e pode rodar com o agente ligado, porque o banco aceita escrita concorrente. Limites como hoje: 30 req/min na API oficial (o teto é 60).
- **`sync:precos`:** grava em `agente.preco_grupos` e atualiza o mesmo `sincronizado_em`.
- **Agendamento:** duas tarefas no Agendador do Windows, na máquina que roda o agente: o incremental a cada 30–60 min e o `sync:precos` à noite.

## 7. Retenção (issue #4)

- `src/operacao/retencao.ts` passa a apagar do banco por data (`atualizado_em < now() - RETENCAO_DIAS`), mantendo o `--executar` (sem o flag, só lista).
- A regra da ponte continua: do estado da ponte só sai o telefone cuja conversa também está saindo.
- Lacunas e orçamentos de teste saem por data. As artes continuam em arquivo, com a lógica de hoje.
- `scripts/limparDados.ts` é adaptado para o banco.

## 8. Ordem de trabalho

Primeiro o que não encosta na busca, para adiantar enquanto o Gui não volta:

1. `src/db/`, `docker-compose.yml`, `db:migrate`, `001_inicial.sql` e `db/papel-agente.sql`.
2. `Pg*` de conversas, ponte (com o modo da Lia), lacunas, orçamentos de teste e pedidos, ligados nos chamadores; saem os `File*` deles.
3. Retenção no banco e o `limparDados` adaptado. Teste de fumaça (critério 4).
4. `002_catalogo.sql` e `PgProductIndexStore`, implementados e com a suíte de contrato, **sem ligar** na busca.
5. `sync:catalogo` incremental e `sync:precos` gravando no banco; as 2 tarefas no Agendador.

Quando a `busca-semantica` voltar:

6. Merge da `busca-semantica`. Os chamadores do catálogo ganham `await`, e a busca passa a receber o índice carregado.
7. `PgTipoStore` e `PgVectorStore` atrás das interfaces do Gui; saem as versões em arquivo dele.
8. Teste de fumaça de novo e os evals.
9. Apagar os arquivos de dados locais da seção 3, com a lista mostrada na hora e a confirmação do João. Ficam a sessão do WhatsApp, as artes e os logs. A máquina do chip é feita pelo dev de lá.

## 9. Dados atuais

Nada migra. O banco nasce vazio: o catálogo e os preços se refazem pelo sync, e conversas, lacunas, orçamentos de teste e estado da ponte começam do zero, porque o produto ainda está em desenvolvimento. Os arquivos saem no passo 9.

## 10. Entrega

- Antes do push, juntar os commits: um `docs` (esta spec e o plano), um `feat` e um `fix`, se houver. Correções vão separadas.
- Push e PR só com o OK do João.
- O pedido ao Dudu (rodar `db/papel-agente.sql` e passar a URL do usuário `agente`) vai junto do PR.

## 11. Fora do escopo

- Sessão do WhatsApp em volume persistente ou RemoteAuth, e storage das artes (item 1.7 da nota).
- Deploy e alinhamento com o Caio sobre a infraestrutura (item 1.9).
- Rodar qualquer coisa no Neon do Dudu.
- Mais de uma instância da API.
