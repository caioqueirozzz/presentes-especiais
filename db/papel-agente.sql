-- Rode uma vez, como dono, no SQL Editor do projeto Neon DO AGENTE (não no do CRM). Troque a senha antes
-- e apague a consulta do History depois: o Neon guarda o texto com a senha.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE agente LOGIN PASSWORD 'TROQUE_ESTA_SENHA';
-- O dono do Neon não é superusuário: sem SET, o AUTHORIZATION abaixo falha; sem INHERIT, ele não lê as conversas por herança.
GRANT agente TO CURRENT_USER WITH INHERIT FALSE;
CREATE SCHEMA IF NOT EXISTS agente AUTHORIZATION agente;
-- Ninguém além do agente usa o schema dele (só o dono do schema pode revogar).
SET ROLE agente;
REVOKE ALL ON SCHEMA agente FROM PUBLIC;
RESET ROLE;
-- O agente não lê o schema public.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM agente;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM agente;
