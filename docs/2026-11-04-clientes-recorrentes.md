# Clientes que voltam: pedido confirmado, urgência e novo pedido

- **Data:** 04/11/2026
- **Autor:** Luis Eduardo
- **Projetos afetados:** agente Lia (pasta raiz) e CRM (`crm/`)

## Objetivo

Criar um fluxo para clientes antigos:

1. Quando o pedido do cliente é confirmado, a qualificação do lead sai do painel e aparecem as tags **Pedido confirmado** e **Já cliente**.
2. O pedido termina quando o card vai para **Entregue**.
3. Se o cliente voltar a escrever depois disso, é para comprar de novo ou para reclamar:
   - **reclamação:** o contato fica **urgente**, identificado por palavras-chave;
   - **compra nova:** o cliente volta para a prospecção e a qualificação.
4. O cliente pode fazer um pedido novo com outro ainda em produção. Nesse caso o lead é qualificado de novo, sem misturar os pedidos.
5. Em **cancelamento ou estorno**, a Lia nunca responde: a conversa vai direto para uma pessoa e fica marcada como urgente.

## Como ficou

| Situação | No CRM | Na Lia |
|---|---|---|
| Pedido cadastrado no quadro (de Pedido confirmado até Expedição) | Temperatura e qualificação somem. Aparecem **Pedido confirmado** e **Já cliente** | O prompt recebe `cliente_da_loja` com os pedidos em andamento, cada um pelo código |
| Pedido movido para **Entregue** | Fica só **Já cliente**: o pedido terminou | O pedido passa para `pedidos_entregues` |
| Cliente volta para comprar | Lead volta para *Novo contato* e *Em qualificação*, com a tag Já cliente. A venda anterior é guardada em `lead_sales` | Chama `iniciar_novo_pedido`: limpa a triagem e mantém nome, PF/PJ, e-mail e empresa |
| Pedido novo com outro em produção | Igual ao caso anterior. O lead mostra os pedidos em andamento (ex.: "PED-0003 · Em produção") separados do pedido novo | Instruída a nunca misturar pedidos e a citar cada um pelo código |
| Reclamação de quem já é cliente | Tag vermelha **Urgente**, topo da lista, aviso à gestão e ao vendedor, filtro "🚨 Urgentes" | Transfere com motivo `reclamacao` e prioridade alta |
| Cancelamento ou estorno | **Urgente** para qualquer contato | **Não responde**: transfere antes de chamar o modelo, com uma mensagem fixa de encaminhamento |

A faixa vermelha no painel do lead tem o botão **Resolvido**, que tira a urgência. A mesma transferência não volta a marcar o contato depois de resolvida.

### Mensagem fixa no cancelamento/estorno

A Lia não gera resposta. Sai só este texto, de `MENSAGEM_CANCELAMENTO` em `src/tools/transferirHumano.ts`:

> Entendi. Cancelamentos e estornos são tratados diretamente pela nossa equipe: já passei sua conversa para uma pessoa, que vai falar com você em instantes. 🙏

### Palavras-chave

As listas ficam em `src/agent/intencao.ts`, com uma cópia idêntica em `crm/src/lib/intencao.ts`, porque o CRM é outro projeto. O teste `tests/clientesRecorrentes.test.ts` falha se as duas divergirem: **altere sempre as duas juntas**.

- **Cancelamento/estorno:** cancelar/cancelamento, estorno, reembolso, ressarcimento, chargeback, dinheiro de volta, devolver o dinheiro, desisti do pedido, não quero mais o pedido.
- **Reclamação:** reclamação, defeito, quebrado/danificado/amassado, veio errado, cor ou quantidade errada, veio faltando, não chegou, atrasado, péssimo, Procon, Reclame Aqui, quero trocar, "tive um problema com o pedido".

Cancelamento vence reclamação: "veio quebrado, quero o estorno" é tratado como estorno.

### Regras de urgência

- **Cancelamento/estorno por palavra-chave:** urgente para qualquer contato.
- **Reclamação por palavra-chave:** urgente só para quem já tem pedido no quadro. Assim, quem ainda está comprando e diz "não pode ter atraso" não vira urgente.
- **Lia transferiu por `reclamacao` ou `cancelamento_estorno`:** urgente para qualquer contato.

### Relatórios

Quando o cliente volta para comprar, o lead sai de "Pedido fechado", e sem cuidado a venda anterior sumiria do faturamento. Por isso ela é arquivada na tabela `lead_sales`. Central do dia, ranking, relatórios e série diária somam essa tabela com o pedido fechado atual.

## Arquivos alterados

### Agente (Lia)

| Arquivo | O que mudou |
|---|---|
| `src/agent/intencao.ts` | **Novo.** Detecção de cancelamento/estorno e reclamação por palavras-chave |
| `src/agent/runTurn.ts` | Cancelamento/estorno transfere antes de chamar o modelo; o prompt recebe o histórico de pedidos do cliente |
| `src/agent/state.ts` | Campos `ciclo`, `novoPedidoIniciadoEm`, `pedidosAnteriores` e `ultimaTransferencia` |
| `src/agent/prompt/system.md` | Seção "Cliente que já comprou" e novas linhas na tabela de intenções |
| `src/integrations/crm/historicoCliente.ts` | **Novo.** Lê os pedidos do cliente no CRM (prazo de 3 s, cache de 1 min) |
| `src/tools/iniciarNovoPedido.ts` | **Novo.** Ferramenta `iniciar_novo_pedido` |
| `src/tools/index.ts`, `src/tools/nomes.ts` | Registro da ferramenta nova |
| `src/tools/transferirHumano.ts` | Motivo `cancelamento_estorno`, `MENSAGEM_CANCELAMENTO` e registro da última transferência |
| `src/api/agenteDefinitivo.ts` | Transferência pelo sistema também registra a última transferência |
| `tests/clientesRecorrentes.test.ts` | **Novo.** 33 testes |
| `tests/setup/semCrm.ts`, `vitest.config.ts` | **Novos.** Nos testes, a Lia não consulta o CRM local apontado pelo `.env` |

### CRM

| Arquivo | O que mudou |
|---|---|
| `crm/db/migrations/005_clientes_recorrentes.sql` | **Novo.** Colunas de urgência e ciclo em `leads`, tabela `lead_sales` e vínculo dos pedidos sem lead |
| `crm/src/lib/intencao.ts` | **Novo.** Cópia das palavras-chave |
| `crm/src/lib/ingest.ts` | Novo ciclo de compra, marcação de urgência e vínculo de pedidos ao lead pelo telefone |
| `crm/src/lib/access.ts` | `LEAD_COLUMNS` traz total de pedidos, pedidos em andamento e data do último pedido |
| `crm/src/lib/types.ts` | Campos novos do lead e `customerStatus()`, que decide as tags e se a qualificação aparece |
| `crm/src/lib/metrics.ts` | Faturamento soma o pedido atual mais `lead_sales` |
| `crm/src/app/api/leads/route.ts` | Urgentes primeiro e filtro `urgent=1` |
| `crm/src/app/api/leads/[id]/route.ts` | Resolver a urgência (`is_urgent: false`) |
| `crm/src/app/api/integracao/pedidos/route.ts` | Modo `?contexto=1` (sem aviso de atraso) e campos `entregue` e `criado_em` |
| `crm/src/components/ui.tsx` | Componentes `UrgentBadge` e `CustomerBadges` |
| `crm/src/components/crm/CrmView.tsx` | Tags na lista e filtro "🚨 Urgentes" |
| `crm/src/components/crm/LeadPanel.tsx` | Tags, faixa de urgência, faixa com os pedidos em andamento e eventos novos no histórico |
| `crm/src/components/boards/BoardsView.tsx` | Tags nos cards dos quadros |
| `crm/README.md` | Seção "Clientes que voltam" |

## Para colocar no ar

1. No CRM, rode `cd crm && npm run db:migrate` para aplicar a `005_clientes_recorrentes.sql`. **Sem ela, a lista de leads quebra.**
2. Reinicie o CRM (`npm run dev`) e a Lia (`npm run whatsapp`).

## Testes

- **Lia:** 874 testes passando, 33 novos. Uma falha (`tests/logPonte.test.ts`) já existia antes destas alterações e não tem relação com elas.
- **CRM:** typecheck passando. Um roteiro de 21 cenários num banco embutido (pglite) passou três vezes, cada vez com um banco novo. Ele cobriu tags, urgência, novo pedido, pedido em produção mais pedido novo e faturamento preservado.
- **Ainda não testado:** conversa real com o modelo e a interface no navegador.

## Limitações conhecidas

- Palavras-chave podem gerar falso positivo ou deixar passar alguma reclamação. Ajuste as listas em `intencao.ts`, nos dois projetos.
- O pedido novo só começa quando a Lia chama `iniciar_novo_pedido`; não há botão no CRM para isso.
- Se o CRM estiver fora do ar, a Lia segue sem o histórico do cliente (`historico_de_pedidos: "indisponivel"`) e se guia pela conversa.
