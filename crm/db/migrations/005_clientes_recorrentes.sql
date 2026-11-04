-- ============================================================
-- Clientes que voltam: pedido confirmado, urgência e novo ciclo de compra.
--
-- - Lead com pedido no quadro é "Já cliente". Enquanto houver pedido não entregue,
--   aparece "Pedido confirmado" no lugar da qualificação.
-- - Reclamação e cancelamento/estorno marcam o contato como urgente.
-- - Cliente que volta para comprar abre um novo ciclo: o lead volta para prospecção e
--   qualificação, e a venda anterior fica guardada em lead_sales (os relatórios somam as duas).
-- Só acrescenta; pode rodar mais de uma vez.
-- ============================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_urgent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS urgent_reason TEXT;
-- Fica depois de resolvido: a mesma transferência não volta a marcar o contato
ALTER TABLE leads ADD COLUMN IF NOT EXISTS urgent_at TIMESTAMPTZ;
-- Ciclo de compra do cliente (o agente conta quantas vezes ele recomeçou um pedido)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS purchase_cycle INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS cycle_started_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_leads_urgent ON leads(is_urgent) WHERE is_urgent;

-- Pedidos fechados de ciclos anteriores. O pedido fechado do ciclo atual continua em leads.won_*.
CREATE TABLE IF NOT EXISTS lead_sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- Quem vendeu na época: a venda não muda de dono se o lead for redistribuído
  seller_id UUID REFERENCES users(id) ON DELETE SET NULL,
  value NUMERIC(12, 2) NOT NULL,
  won_at TIMESTAMPTZ NOT NULL,
  cycle INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_sales_lead ON lead_sales(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_sales_won ON lead_sales(won_at);

-- Pedido cadastrado antes de o cliente escrever ficou sem lead: liga pelo telefone
UPDATE orders o SET lead_id = l.id FROM leads l WHERE o.lead_id IS NULL AND l.phone = o.phone;
