-- Rode uma vez, como dono do banco, no SQL Editor do Neon. Troque a senha antes.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE agente LOGIN PASSWORD 'TROQUE_ESTA_SENHA';
CREATE SCHEMA IF NOT EXISTS agente AUTHORIZATION agente;
-- Ninguém além do agente usa o schema dele.
REVOKE ALL ON SCHEMA agente FROM PUBLIC;
-- O agente não lê as tabelas do CRM.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM agente;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM agente;
