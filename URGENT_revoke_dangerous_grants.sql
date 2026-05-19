-- 🚨 URGENTE — rodar ANTES de qualquer outra coisa.
-- Audit revelou:
--   • anon       tem TRUNCATE (bypassa RLS — apaga tudo sem login)
--   • authenticated tem DELETE (qualquer corretor apaga tudo via DevTools)
--   • service_role NÃO tem SELECT/DELETE (Edge Function admin-clear-history falha)

-- ─── 1. REVOGAR TUDO DESNECESSÁRIO de anon e authenticated ──────────────────
REVOKE TRUNCATE  ON public.historico_contratos FROM anon;
REVOKE TRUNCATE  ON public.historico_contratos FROM authenticated;
REVOKE DELETE    ON public.historico_contratos FROM authenticated;
REVOKE REFERENCES ON public.historico_contratos FROM anon;
REVOKE REFERENCES ON public.historico_contratos FROM authenticated;
REVOKE TRIGGER   ON public.historico_contratos FROM anon;
REVOKE TRIGGER   ON public.historico_contratos FROM authenticated;

-- ─── 2. GARANTIR que service_role tem o necessário ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.historico_contratos TO service_role;

-- ─── 3. CONFIRMAR resultado (deve ficar mínimo: authenticated só SELECT) ───
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'historico_contratos'
ORDER BY grantee, privilege_type;
-- Esperado APÓS:
--   anon          | (nada — sem grants problemáticos)
--   authenticated | SELECT
--   postgres      | (default — owner)
--   service_role  | DELETE, INSERT, SELECT, UPDATE
