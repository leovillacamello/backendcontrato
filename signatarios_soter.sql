-- Soter — Signatários fixos (diretores da vendedora e testemunhas)
-- Editáveis pelo Admin. Antes ficavam fixos em src/config/signatarios.ts.

create table if not exists public.signatarios_soter (
  id         uuid primary key default gen_random_uuid(),
  tipo       text not null check (tipo in ('diretor', 'testemunha')),
  nome       text not null,
  email      text not null,
  cpf        text,
  rg         text,
  ordem      integer not null default 0,   -- p/ diretores (1=Poerner, 2=Pecly) e ordenação
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists signatarios_soter_tipo_idx on public.signatarios_soter (tipo, ordem);

create trigger signatarios_soter_set_updated_at
  before update on public.signatarios_soter
  for each row execute function public.set_updated_at();

-- RLS: usuário autenticado tem CRUD completo (mesmo padrão de corretores).
alter table public.signatarios_soter enable row level security;
create policy "signatarios_select" on public.signatarios_soter for select to authenticated using (true);
create policy "signatarios_insert" on public.signatarios_soter for insert to authenticated with check (true);
create policy "signatarios_update" on public.signatarios_soter for update to authenticated using (true) with check (true);
create policy "signatarios_delete" on public.signatarios_soter for delete to authenticated using (true);
grant select, insert, update, delete on public.signatarios_soter to authenticated;

-- Popula com os signatários atuais (idempotente: só insere se a tabela estiver vazia).
insert into public.signatarios_soter (tipo, nome, email, cpf, rg, ordem)
select * from (values
  ('diretor',    'Leonardo Poerner',                 'leonardo.poerner@soter.com.br', null,             null,          1),
  ('diretor',    'Rodrigo Pely',                      'rodrigo.pecly@soter.com.br',    null,             null,          2),
  ('testemunha', 'Bernardo de Souza Macedo',          'bernardo.macedo@soter.com.br',  '101.859.777-82', '27938650-2',  1),
  ('testemunha', 'Joecy Helena Avila Guedes',         'joecy.guedes@soter.com.br',     '166.919.287-33', '26554362-9',  2),
  ('testemunha', 'Leonardo Villaça de Farias Mello',  'leonardo.mello@soter.com.br',   '173.315.307-12', '27.329.699-6', 3)
) as v(tipo, nome, email, cpf, rg, ordem)
where not exists (select 1 from public.signatarios_soter);
