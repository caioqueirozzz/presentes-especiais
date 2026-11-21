CREATE TABLE IF NOT EXISTS agente.conversas (
  telefone TEXT PRIMARY KEY CHECK (telefone ~ '^[0-9]{10,15}$'),
  doc JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversas_atualizado_em ON agente.conversas (atualizado_em);

CREATE TABLE IF NOT EXISTS agente.conversas_corrompidas (
  id BIGSERIAL PRIMARY KEY,
  telefone TEXT NOT NULL,
  doc JSONB,
  erro TEXT NOT NULL,
  separado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agente.estado_ponte (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  doc JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agente.modo_lia (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  config JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agente.estado_sistema (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  estado JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agente.lacunas (
  id BIGSERIAL PRIMARY KEY,
  conversa_id TEXT NOT NULL,
  pergunta TEXT NOT NULL,
  categoria_sugerida TEXT,
  registrado_em TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS lacunas_registrado_em ON agente.lacunas (registrado_em);
CREATE INDEX IF NOT EXISTS lacunas_conversa ON agente.lacunas (conversa_id);

CREATE TABLE IF NOT EXISTS agente.pedidos (
  id TEXT PRIMARY KEY,
  codigo TEXT NOT NULL,
  telefone TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  criado_em TEXT NOT NULL,
  sincronizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pedidos_codigo ON agente.pedidos (codigo);
