-- ─── CORREÇÃO DE SEGURANÇA — pós-auditoria ──────────────────────────────────
-- Rodar no SQL Editor do Supabase. Todas as operações são seguras (não
-- quebram o fluxo atual do app). A query final confirma o estado.

-- ── 1. CRÍTICO: usuarios_autorizados — anon com TRUNCATE (DoS) ──────────────
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.usuarios_autorizados FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.usuarios_autorizados FROM authenticated;

-- ── 2. CRÍTICO: Storage — qualquer logado apaga qualquer contrato ──────────
-- Exclusão de contrato é feita pela Edge Function delete-contrato (service_role).
-- Não deve haver policy de DELETE para authenticated no bucket contratos.
DROP POLICY IF EXISTS "contratos_delete" ON storage.objects;

-- ── 3. MÉDIO: empreendimentos — INSERT sem condição ────────────────────────
-- A policy insert_admin permitia qualquer authenticated inserir. Recria com
-- a regra de admin (o admin loga como authenticated; a Edge Function não usa).
DROP POLICY IF EXISTS "insert_admin" ON public.empreendimentos;
CREATE POLICY "insert_admin" ON public.empreendimentos
  FOR INSERT TO authenticated
  WITH CHECK ((auth.jwt() ->> 'email') = 'adm@soter.com.br');

-- ── 4. MÉDIO: Storage — upload sem condição ────────────────────────────────
-- wrvard_1 (INSERT) estava sem condição. Recria restrita: admin sobe template;
-- contratos são gravados pela Edge Function (service_role, policy contratos_insert).
DROP POLICY IF EXISTS "admin pode upload wrvard_1" ON storage.objects;
CREATE POLICY "upload_admin" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK ((auth.jwt() ->> 'email') = 'adm@soter.com.br');

-- ── 5. MÉDIO: historico_contratos — policy de DELETE com USING(true) ───────
-- Bomba adormecida: hoje o grant bloqueia, mas a policy reabriria tudo se o
-- DELETE fosse reconcedido. Exclusão é via Edge Functions (service_role).
DROP POLICY IF EXISTS "delete_authenticated" ON public.historico_contratos;

-- ── 6. LIMPEZA: policy de INSERT órfã em historico_contratos ───────────────
-- INSERT é feito só pela Edge Function gerar-contrato (service_role).
DROP POLICY IF EXISTS "historico_inserir" ON public.historico_contratos;

-- ── 7. usuarios_autorizados — GRANT SELECT para o login funcionar ──────────
-- O checkAuthorized (não-admin) e o painel de usuários (admin) precisam de
-- SELECT. As policies existentes já restringem: não-admin vê só a própria
-- linha ("Usuário verifica próprio acesso"); admin vê tudo ("Admin gerencia
-- tudo"). INSERT/UPDATE/DELETE NÃO são concedidos — isso é feito pelas Edge
-- Functions admin-add-usuario / admin-remove-usuario (service_role).
GRANT SELECT ON public.usuarios_autorizados TO authenticated;

-- ── CONFIRMAÇÃO ────────────────────────────────────────────────────────────
SELECT polrelid::regclass AS tabela, polname, polcmd
FROM pg_policy
WHERE polrelid IN ('public.historico_contratos'::regclass,
                   'public.empreendimentos'::regclass,
                   'storage.objects'::regclass)
ORDER BY tabela, polcmd;
