-- ─── ADMIN CLEAR HISTORY — auditoria de RLS ──────────────────────────────────
-- Roda no Supabase SQL Editor APÓS deployar a Edge Function admin-clear-history.
-- Garante que DELETE em historico_contratos só funciona pra service_role
-- (usada pela Edge Function), nunca pra anon/authenticated.

-- 1. Confirmar que RLS está habilitada
SELECT relname, relrowsecurity AS rls_enabled
FROM pg_class
WHERE relname = 'historico_contratos';
-- Esperado: rls_enabled = true.

-- 2. Listar TODAS as policies da tabela (DELETE = polcmd 'd')
SELECT polname, polcmd, polroles::regrole[], polqual::text, polwithcheck::text
FROM pg_policy
WHERE polrelid = 'public.historico_contratos'::regclass
ORDER BY polcmd, polname;
-- Esperado: NENHUMA linha com polcmd = 'd'. Se houver, dropar (passo 3).

-- 3. Dropar policy permissiva de DELETE se existir (descomentar e ajustar nome)
-- DROP POLICY "<nome_da_policy_de_delete>" ON public.historico_contratos;

-- 4. Confirmar grants — service_role tem tudo, authenticated só SELECT
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'historico_contratos'
ORDER BY grantee, privilege_type;
-- Esperado:
--   anon                | (nada, ou SELECT se for query pública desejada)
--   authenticated       | SELECT
--   service_role        | DELETE, INSERT, SELECT, UPDATE
-- Se "authenticated" tem DELETE, REVOKE: REVOKE DELETE ON public.historico_contratos FROM authenticated;
