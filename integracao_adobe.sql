-- Soter — Integração Adobe Acrobat Sign
-- Guarda os tokens OAuth (1 linha só). NENHUM cliente acessa: RLS ligada sem
-- policies + grants revogados. Só as Edge Functions (service_role) leem/escrevem.

create table if not exists public.integracao_adobe (
  id               text primary key default 'adobe',
  refresh_token    text,
  access_token     text,
  token_expira     timestamptz,           -- validade do access_token (cache)
  api_access_point text,                  -- base p/ chamadas (vem do Adobe)
  web_access_point text,
  oauth_state      text,                  -- antifraude do fluxo OAuth (temporário)
  updated_at       timestamptz not null default now(),
  constraint integracao_adobe_singleton check (id = 'adobe')
);

-- linha única garantida
insert into public.integracao_adobe (id) values ('adobe')
  on conflict (id) do nothing;

-- Tranca para clientes; só service_role (Edge Functions) acessa.
alter table public.integracao_adobe enable row level security;
revoke all on public.integracao_adobe from anon, authenticated;
grant all on public.integracao_adobe to service_role;
