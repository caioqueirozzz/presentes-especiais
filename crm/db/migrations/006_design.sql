-- Papel novo
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('ADMIN', 'COLABORADOR', 'DESIGNER'));

-- ajuste 1: rodízio do designer, separado do rodízio de vendedores
ALTER TABLE crm_settings ADD COLUMN IF NOT EXISTS last_designer_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS design_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  designer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,  -- null = Lia
  origem TEXT NOT NULL CHECK (origem IN ('LIA', 'VENDEDOR', 'PEDIDO')),
  stage TEXT NOT NULL DEFAULT 'RECEBIDO' CHECK (stage IN (
    'RECEBIDO', 'PROCESSANDO_IA', 'NA_FILA', 'EM_CRIACAO',
    'AGUARDANDO_CLIENTE', 'AJUSTES', 'APROVADO', 'CANCELADO')),
  ia_status TEXT NOT NULL DEFAULT 'PENDENTE'
    CHECK (ia_status IN ('PENDENTE', 'OK', 'FALHOU', 'SEM_IMAGEM')),  -- ajuste 2: SEM_IMAGEM
  ia_tentativas INTEGER NOT NULL DEFAULT 0,                          -- ajuste 2
  ia_proxima_tentativa_em TIMESTAMPTZ,                               -- ajuste 2: espera entre tentativas
  ficha JSONB NOT NULL DEFAULT '{}'::jsonb,
  briefing TEXT,
  prioridade TEXT NOT NULL DEFAULT 'normal' CHECK (prioridade IN ('normal', 'alta')),
  prazo TIMESTAMPTZ,
  conversa_com_designer BOOLEAN NOT NULL DEFAULT false,
  confirmacao_pedida_em TIMESTAMPTZ,                                 -- ajuste 3: dupla confirmação
  confirmacao_versao INTEGER,                                        -- ajuste 3
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_design_jobs_stage ON design_jobs(stage);
CREATE INDEX IF NOT EXISTS idx_design_jobs_designer ON design_jobs(designer_id);
CREATE INDEX IF NOT EXISTS idx_design_jobs_lead ON design_jobs(lead_id);
-- ajuste 4: no máximo um job aberto por lead
CREATE UNIQUE INDEX IF NOT EXISTS uq_design_jobs_lead_aberto
  ON design_jobs(lead_id) WHERE stage NOT IN ('APROVADO', 'CANCELADO');

CREATE TABLE IF NOT EXISTS design_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES design_jobs(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN (
    'ORIGINAL', 'LOGO', 'ESTAMPA', 'TEXTO', 'PALETA',
    'SVG', 'MOCKUP', 'ARTE_FINAL')),
  arquivo TEXT,          -- CHAVE no armazém (ex.: design/<job>/original-1.jpg), nunca URL
  mime TEXT,
  bytes INTEGER,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  versao INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_design_assets_job ON design_assets(job_id, tipo);

CREATE TABLE IF NOT EXISTS design_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES design_jobs(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- null = sistema, Lia ou cliente
  tipo TEXT NOT NULL,
  dados JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_design_events_job ON design_events(job_id, created_at);
