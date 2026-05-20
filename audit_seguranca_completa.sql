-- ─── AUDITORIA DE SEGURANÇA COMPLETA ────────────────────────────────────────
-- Rodar no SQL Editor do Supabase. Copiar TODOS os 5 resultados de volta.
-- Objetivo: confirmar que a anon key (pública) e qualquer login não dão
-- acesso indevido a dados.

-- 1. RLS habilitada? (rls_habilitada = false numa tabela com grant = exposição)
SELECT relname AS tabela, relrowsecurity AS rls_habilitada
FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
ORDER BY relname;

-- 2. Grants de anon / authenticated em TODAS as tabelas public
--    (anon = sem login; authenticated = qualquer usuário logado)
SELECT table_name, grantee,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privilegios
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
GROUP BY table_name, grantee
ORDER BY table_name, grantee;

-- 3. Policies de RLS de cada tabela (polcmd: r=SELECT, a=INSERT, w=UPDATE,
--    d=DELETE, *=ALL). qual = condição da policy.
SELECT polrelid::regclass AS tabela, polname,
       polcmd, polroles::regrole[] AS roles, polqual::text AS condicao
FROM pg_policy
WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
ORDER BY tabela, polcmd;

-- 4. Buckets de Storage — public = true significa leitura sem autenticação
SELECT id, name, public, file_size_limit
FROM storage.buckets
ORDER BY name;

-- 5. Policies do Storage (controle de acesso aos arquivos)
SELECT polname, polcmd, polroles::regrole[] AS roles, polqual::text AS condicao
FROM pg_policy
WHERE polrelid = 'storage.objects'::regclass
ORDER BY polcmd;
