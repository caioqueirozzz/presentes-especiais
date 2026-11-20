# Pedido ao Dudu: banco do agente no Neon

O agente guarda o estado num **projeto Neon próprio**, separado do CRM, com o usuário `agente`.

Por que não no mesmo banco do CRM (revisto em 11/11): no Neon, o dono do banco (`neondb_owner`) é membro de `pg_read_all_data` e `pg_write_all_data`, e isso não pode ser revogado. Num banco só, quem tivesse a credencial do CRM leria e alteraria as conversas e o estado do agente. Em projetos separados, a credencial de um não abre o outro. O CRM não precisa ler o banco do agente, porque recebe as mensagens ao vivo pela ponte, por HTTP.

1. Crie no Neon um projeto para o agente, com Postgres 17 e na mesma região do CRM.
2. No SQL Editor desse projeto, como dono, rode `db/papel-agente.sql` **trocando a senha** antes. Depois, apague a consulta do History, porque o Neon guarda o texto com a senha.
   - O script cria a extensão `vector`, o usuário `agente` e o schema `agente`. O usuário `agente` não tem CREATE no banco (privilégio mínimo).
   - Use uma senha só com letras e números: ela vai dentro de uma URL.
3. Mande ao João, por canal privado, a URL do usuário `agente`, no formato
   `postgres://agente:<senha>@<host>.neon.tech/neondb?sslmode=verify-full`. Use o host sem `-pooler`.
4. Você não roda migrations: o agente aplica as próprias ao subir.
5. A credencial de dono do projeto novo não vai para nenhum servidor. Ative a autenticação em dois fatores na conta do Neon: quem entra no console lê os dois projetos.
6. O `sync:agente` do CRM (`crm/scripts/syncAgente.ts`) lia as conversas em arquivo do agente, e esses arquivos deixam de existir. Como a ponte já manda as mensagens ao vivo para o CRM, o `sync:agente` pode sair. Ele também pode passar a ler outra fonte, se você ainda precisar importar histórico. A decisão é sua.
7. Melhoria opcional no CRM: hoje ele conecta como dono do banco, e essa credencial lê e escreve tudo. Um usuário próprio só com acesso ao `public` (`crm_app`) reduz o estrago se ela vazar.
