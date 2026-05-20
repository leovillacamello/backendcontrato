# Soter Contratos — Backend

Supabase Edge Functions (Deno + TypeScript) do gerador de contratos da Soter
Incorporadora. Frontend separado no repo `Soter_Contratos`.

## Edge Functions (`supabase/functions/`)

- **`gerar-contrato`** — núcleo. Recebe o payload do frontend e gera o `.docx`
  do contrato manipulando XML OOXML. Arquivo monolítico (~1900 linhas).
- **`admin-clear-history`** — apaga todo o histórico (admin only).
- **`admin-delete-empreendimento`** — exclui empreendimento + unidades +
  templates exclusivos; preserva o histórico (admin only).
- **`delete-contrato`** — exclui um contrato do histórico (dono ou admin).
- **`historico-geral`** — histórico consolidado de todos os empreendimentos.

## Comandos

- **Deploy:** `supabase functions deploy <nome> --project-ref adngbijkqkuaqwggjllo`
  (não há deploy automático por git push). `deploy.bat` faz pull + deploy do
  `gerar-contrato`.
- Não há suíte de testes nem typecheck local (Deno não instalado no ambiente).

## Padrão de segurança das Edge Functions

Toda função segue o mesmo esqueleto — replicar ao criar novas:
1. CORS **strict** — sem fallback `*`; origem fora da allowlist → 403.
2. JWT obrigatório (`Authorization: Bearer`), validado via `supabaseAuth.auth.getUser`.
3. Autorização: admin (`ADMIN_EMAILS`) ou dono, conforme o caso.
4. `service_role` só para a operação privilegiada em si.
5. Auditoria via `console.log`/`console.warn` com user_email + ação.

## Banco / RLS

- `historico_contratos`, `empreendimentos`, `unidades` — RLS habilitada.
  `authenticated` tem só leitura; DELETE/escrita privilegiada vai por Edge
  Function com `service_role`.
- GRANTs perigosos (TRUNCATE/DELETE para anon/authenticated) já foram
  revogados — ver `URGENT_*.sql`. Conferir antes de criar tabela nova.
- SQL solto no repo (`*.sql`) é rodado manualmente no SQL Editor do Supabase.

## Regras de domínio (geração do contrato)

- Tipos de parcela no backend (lowercase): `ato` (sinal), `complemento`,
  `mensal`, `semestral`, `anual`, `unica`, `financiamento`.
- Complemento lida tanto com 1 linha qty=2 quanto 2 linhas qty=1.
- Venda **à vista** detectada quando `sinal >= preço` → usa template à vista.
- Templates por empreendimento ficam no bucket Storage `templates`,
  prefixados pela sigla. Contratos gerados vão no bucket `contratos`.
- Validação de input: datas (`parseDateParts`), CPF/CNPJ por dígito
  verificador. `bypass_documento_invalido` permite gerar com doc fictício.

## Convenções

- Manter o padrão de segurança acima em qualquer função nova.
- Não commitar sem o usuário pedir. Após mexer numa função, lembrar que o
  deploy é manual (`supabase functions deploy`).
