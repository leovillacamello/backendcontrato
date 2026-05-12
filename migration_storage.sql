-- ─── 1. Colunas novas na tabela histórico ─────────────────────────────────────
ALTER TABLE public.historico_contratos
  ADD COLUMN IF NOT EXISTS storage_path TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS user_id      UUID,
  ADD COLUMN IF NOT EXISTS user_email   TEXT NOT NULL DEFAULT '';

-- ─── 2. Permitir DELETE para usuários autenticados (botão excluir do frontend)
GRANT DELETE ON public.historico_contratos TO authenticated;

CREATE POLICY "delete_authenticated" ON public.historico_contratos
  FOR DELETE TO authenticated
  USING (true);

-- ─── 3. Bucket "contratos" (arquivos .docx gerados) ───────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'contratos',
  'contratos',
  false,
  10485760,
  ARRAY['application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
ON CONFLICT (id) DO NOTHING;

-- Leitura e download para autenticados
CREATE POLICY "contratos_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'contratos');

-- Exclusão para autenticados (frontend pode apagar arquivo ao excluir registro)
CREATE POLICY "contratos_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'contratos');

-- Inserção apenas pela Edge Function (service_role)
CREATE POLICY "contratos_insert" ON storage.objects
  FOR INSERT TO service_role
  WITH CHECK (bucket_id = 'contratos');
