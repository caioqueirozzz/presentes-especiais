# Pedido ao Dudu: banco do agente no Neon

O agente passa a guardar o estado no mesmo Neon do CRM, num schema separado (`agente`) e com usuário próprio. O CRM não lê esse schema, e o agente não lê as tabelas do CRM.

1. No SQL Editor do Neon, como dono do banco, rode `db/papel-agente.sql` **trocando a senha** antes. O arquivo cria o schema `agente` e a extensão `vector`, que precisam existir antes da primeira conexão do agente: o usuário `agente` não tem CREATE no banco (privilégio mínimo).
2. Mande ao João, por canal privado, a URL do usuário `agente`, no formato
   `postgres://agente:<senha>@<host>.neon.tech/<banco>?sslmode=require`.
3. Você não roda migrations: o agente aplica as próprias ao subir.
4. O `sync:agente` do CRM (`crm/scripts/syncAgente.ts`) lê as conversas em arquivo do agente. Com o banco, esses arquivos deixam de existir. Como a ponte já manda as mensagens ao vivo para o CRM, o `sync:agente` pode sair, ou passar a ler outra fonte se você ainda precisar importar histórico. A decisão é sua.
