-- Tabela de histórico de contratos gerados
CREATE TABLE IF NOT EXISTS public.historico_contratos (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sigla       text NOT NULL DEFAULT '',
  bloco       text NOT NULL DEFAULT '',
  unidade     text NOT NULL DEFAULT '',
  comprador   text NOT NULL DEFAULT '',
  tipo_comissao text NOT NULL DEFAULT '',
  valor_total numeric(15,2),
  nome_arquivo text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Leitura pública (anon key pode SELECT)
ALTER TABLE public.historico_contratos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "leitura_publica" ON public.historico_contratos
  FOR SELECT USING (true);

-- service_role pode INSERT (Edge Function usa service_role)
GRANT INSERT ON public.historico_contratos TO service_role;
GRANT SELECT ON public.historico_contratos TO anon;
GRANT SELECT ON public.historico_contratos TO authenticated;
