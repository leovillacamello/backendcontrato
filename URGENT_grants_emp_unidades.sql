-- 🚨 URGENTE — service_role sem GRANTs em empreendimentos e unidades.
-- Mesmo problema que descobrimos em historico_contratos: a tabela foi criada
-- sem GRANT explícito pra service_role, e Postgres não dá permissão por omissão.
--
-- Isso quebra:
--   • admin-delete-empreendimento (erro "permission denied for table empreendimentos")
--   • gerar-contrato (engole o erro pelo bug C1; deve estar funcionando por sorte/cache)
--   • Tudo que dependa de service_role acessar essas tabelas

-- ─── 1. GRANTs pra service_role ────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.empreendimentos TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.unidades        TO service_role;

-- ─── 2. REVOGAR grants perigosos de anon/authenticated nessas tabelas ─────
-- (mesmo padrão da auditoria anterior — defesa em profundidade)
REVOKE TRUNCATE   ON public.empreendimentos FROM anon;
REVOKE TRUNCATE   ON public.empreendimentos FROM authenticated;
REVOKE REFERENCES ON public.empreendimentos FROM anon;
REVOKE REFERENCES ON public.empreendimentos FROM authenticated;
REVOKE TRIGGER    ON public.empreendimentos FROM anon;
REVOKE TRIGGER    ON public.empreendimentos FROM authenticated;

REVOKE TRUNCATE   ON public.unidades FROM anon;
REVOKE TRUNCATE   ON public.unidades FROM authenticated;
REVOKE DELETE     ON public.unidades FROM authenticated;
REVOKE REFERENCES ON public.unidades FROM anon;
REVOKE REFERENCES ON public.unidades FROM authenticated;
REVOKE TRIGGER    ON public.unidades FROM anon;
REVOKE TRIGGER    ON public.unidades FROM authenticated;

-- ─── 3. CONFIRMAR ─────────────────────────────────────────────────────────
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('empreendimentos', 'unidades')
ORDER BY table_name, grantee, privilege_type;
-- Esperado APÓS:
--   empreendimentos | authenticated | SELECT
--   empreendimentos | postgres      | (default — owner)
--   empreendimentos | service_role  | DELETE, INSERT, SELECT, UPDATE
--   unidades        | authenticated | SELECT
--   unidades        | postgres      | (default — owner)
--   unidades        | service_role  | DELETE, INSERT, SELECT, UPDATE
