-- Mesmos papéis do Neon (db/papel-agente.sql), com senha de dev, mais um "crm" para conferir o isolamento.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE agente LOGIN PASSWORD 'agente';
CREATE ROLE crm LOGIN PASSWORD 'crm';
CREATE SCHEMA agente AUTHORIZATION agente;
REVOKE ALL ON SCHEMA agente FROM PUBLIC;
CREATE TABLE public.crm_teste (id INT);
ALTER TABLE public.crm_teste OWNER TO crm;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM agente;
