CREATE TABLE IF NOT EXISTS agente.produtos (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agente.catalogo_estado (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  versao INT NOT NULL,
  sincronizado_em TEXT NOT NULL,
  completo BOOLEAN NOT NULL
);

-- Da busca semântica (Gui): ligadas na Tarefa 10, quando a busca-semantica voltar.
CREATE TABLE IF NOT EXISTS agente.tipos_produto (
  produto_id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agente.vetores_produto (
  produto_id TEXT PRIMARY KEY,
  vetor vector(1536) NOT NULL,
  modelo TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agente.vetores_tipo (
  tipo TEXT PRIMARY KEY,
  vetor vector(1536) NOT NULL,
  modelo TEXT NOT NULL
);
