-- Adiciona colunas de atribuição de templates por role no empreendimento.
-- Se as colunas forem NULL, o backend usa a convenção de nome padrão como fallback.
ALTER TABLE empreendimentos
  ADD COLUMN IF NOT EXISTS template_contrato_destacada TEXT,
  ADD COLUMN IF NOT EXISTS template_corpo_destacada    TEXT,
  ADD COLUMN IF NOT EXISTS template_contrato_faturada  TEXT,
  ADD COLUMN IF NOT EXISTS template_corpo_faturada     TEXT;
