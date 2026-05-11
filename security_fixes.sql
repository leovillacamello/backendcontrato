-- ─── SECURITY FIXES — executar no Supabase SQL Editor ────────────────────────

-- VULN-14: adicionar user_id e user_email à tabela histórico
ALTER TABLE public.historico_contratos
  ADD COLUMN IF NOT EXISTS user_id    uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS user_email text NOT NULL DEFAULT '';

-- VULN-6: remover policy pública e restringir por usuário autenticado
DROP POLICY IF EXISTS "leitura_publica" ON public.historico_contratos;

-- Usuários só veem contratos que eles mesmos geraram
CREATE POLICY "leitura_proprio_usuario" ON public.historico_contratos
  FOR SELECT
  USING (auth.uid() = user_id);

-- Revogar acesso anônimo
REVOKE SELECT ON public.historico_contratos FROM anon;
GRANT SELECT ON public.historico_contratos TO authenticated;

-- VULN-11: habilitar RLS na tabela unidades (estava sem RLS)
ALTER TABLE public.unidades ENABLE ROW LEVEL SECURITY;

-- Apenas usuários autenticados podem ler unidades
CREATE POLICY "leitura_autenticada_unidades" ON public.unidades
  FOR SELECT
  USING (auth.role() = 'authenticated');

REVOKE ALL ON public.unidades FROM anon;
GRANT SELECT ON public.unidades TO authenticated;
