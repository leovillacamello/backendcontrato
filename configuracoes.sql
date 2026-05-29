-- Soter — Configurações gerais (chave/valor). Editáveis pelo Admin.
-- Hoje guarda o e-mail de cópia (CC) do contrato assinado; serve p/ outros
-- ajustes no futuro.

create table if not exists public.configuracoes (
  chave      text primary key,
  valor      text,
  updated_at timestamptz not null default now()
);

create trigger configuracoes_set_updated_at
  before update on public.configuracoes
  for each row execute function public.set_updated_at();

alter table public.configuracoes enable row level security;
create policy "configuracoes_select" on public.configuracoes for select to authenticated using (true);
create policy "configuracoes_insert" on public.configuracoes for insert to authenticated with check (true);
create policy "configuracoes_update" on public.configuracoes for update to authenticated using (true) with check (true);
grant select, insert, update on public.configuracoes to authenticated;

-- valor inicial do e-mail de cópia
insert into public.configuracoes (chave, valor) values ('email_copia', 'comercial@soter.com.br')
  on conflict (chave) do nothing;
