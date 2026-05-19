// Soter — Edge Function: admin-delete-empreendimento
// Apaga um empreendimento e suas dependências diretas (unidades + templates
// EXCLUSIVOS). Preserva histórico de contratos (use admin-clear-history para
// limpar histórico separadamente). Autorização server-side.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ADMIN_EMAILS = new Set([
  "adm@soter.com.br",
]);

const ORIGENS_PERMITIDAS = new Set([
  "https://adngbijkqkuaqwggjllo.supabase.co",
  "https://soter-contratos-ps58ghmbn-leovillacamellos-projects.vercel.app",
  "https://soter-contratos.vercel.app",
]);

const STORAGE_BATCH_SIZE = 100;

// Colunas de template em `empreendimentos` (paths para arquivos no bucket
// `templates`). Mantenas em sincronia com TemplatesTab.tsx do frontend.
const TEMPLATE_COLUMNS = [
  "template_contrato_destacada",
  "template_corpo_destacada",
  "template_contrato_cabeca_avista",
  "template_contrato_faturada",
  "template_corpo_faturada",
  "template_contrato_semcomissao",
  "template_corpo_semcomissao",
  "template_contrato_semcomissao_avista",
] as const;

interface DeleteRequest {
  sigla: string;
}

serve(async (req) => {
  // CORS strict: sem fallback "*" quando Origin ausente
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = ORIGENS_PERMITIDAS.has(origin) ? origin : null;
  if (!allowedOrigin) {
    return new Response("Forbidden", { status: 403 });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // 🔒 1. Autenticação
  const authHeader = req.headers.get("authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    return new Response(
      JSON.stringify({ error: "Autenticação necessária" }),
      { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(jwt);
  if (authError || !user) {
    return new Response(
      JSON.stringify({ error: "Token inválido ou expirado" }),
      { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  // 🔒 2. Autorização: admin only
  const userEmail = (user.email ?? "").toLowerCase();
  if (!ADMIN_EMAILS.has(userEmail)) {
    console.warn(`[admin-delete-empreendimento] Negado para ${userEmail} (user_id=${user.id})`);
    return new Response(
      JSON.stringify({ error: "Apenas administradores podem executar esta ação" }),
      { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  // 3. Payload
  let body: DeleteRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Payload JSON inválido" }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  const sigla = (body?.sigla || "").trim();
  if (!sigla) {
    return new Response(
      JSON.stringify({ error: "Campo obrigatório: sigla" }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // 4a. Confirmar que o empreendimento existe e buscar as paths de templates
    const selectCols = ["sigla", ...TEMPLATE_COLUMNS].join(",");
    const { data: emp, error: empErr } = await supabaseAdmin
      .from("empreendimentos")
      .select(selectCols)
      .eq("sigla", sigla)
      .maybeSingle();

    if (empErr) {
      console.error("[admin-delete-empreendimento] Erro fetch emp:", empErr.message);
      return new Response(
        JSON.stringify({ error: `Falha ao buscar empreendimento: ${empErr.message}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }
    if (!emp) {
      return new Response(
        JSON.stringify({ error: `Empreendimento "${sigla}" não encontrado` }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // 4b. Coletar paths dos templates DESTE empreendimento (não-nulos, únicos)
    // deno-lint-ignore no-explicit-any
    const empRow = emp as any;
    const templatePaths = new Set<string>();
    for (const col of TEMPLATE_COLUMNS) {
      const v = empRow[col];
      if (typeof v === "string" && v.trim()) templatePaths.add(v.trim());
    }

    // 4c. Verificar quais paths são COMPARTILHADOS com outros empreendimentos
    const sharedPaths = new Set<string>();
    if (templatePaths.size > 0) {
      const orFilter = TEMPLATE_COLUMNS
        .map((c) => [...templatePaths].map((p) => `${c}.eq.${p}`).join(","))
        .join(",");
      const { data: outros, error: outrosErr } = await supabaseAdmin
        .from("empreendimentos")
        .select(selectCols)
        .neq("sigla", sigla)
        .or(orFilter);
      if (outrosErr) {
        console.warn("[admin-delete-empreendimento] Falha ao checar templates compartilhados:", outrosErr.message);
        // Defensivo: se a query falhou, marca TODOS como compartilhados (não apaga)
        templatePaths.forEach((p) => sharedPaths.add(p));
      } else {
        for (const o of outros || []) {
          for (const col of TEMPLATE_COLUMNS) {
            // deno-lint-ignore no-explicit-any
            const v = (o as any)[col];
            if (typeof v === "string" && templatePaths.has(v)) sharedPaths.add(v);
          }
        }
      }
    }

    const pathsParaApagar = [...templatePaths].filter((p) => !sharedPaths.has(p));

    // 5. Apagar templates exclusivos do Storage (em lotes)
    let templatesApagados = 0;
    let storageErrors = 0;
    for (let i = 0; i < pathsParaApagar.length; i += STORAGE_BATCH_SIZE) {
      const batch = pathsParaApagar.slice(i, i + STORAGE_BATCH_SIZE);
      const { data: rmData, error: rmErr } = await supabaseAdmin.storage.from("templates").remove(batch);
      if (rmErr) {
        storageErrors++;
        console.error(`[admin-delete-empreendimento] Erro storage lote ${i}:`, rmErr.message);
      } else {
        templatesApagados += rmData?.length ?? 0;
      }
    }

    // 6. Apagar unidades (DB)
    const { count: unidadesApagadas, error: unErr } = await supabaseAdmin
      .from("unidades")
      .delete({ count: "exact" })
      .eq("sigla", sigla);
    if (unErr) {
      console.error("[admin-delete-empreendimento] Erro delete unidades:", unErr.message);
      return new Response(
        JSON.stringify({ error: `Falha ao apagar unidades: ${unErr.message}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // 7. Apagar a linha do empreendimento
    const { error: delEmpErr } = await supabaseAdmin
      .from("empreendimentos")
      .delete()
      .eq("sigla", sigla);
    if (delEmpErr) {
      console.error("[admin-delete-empreendimento] Erro delete emp:", delEmpErr.message);
      return new Response(
        JSON.stringify({ error: `Falha ao apagar empreendimento: ${delEmpErr.message}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    console.log(
      `[admin-delete-empreendimento] OK — admin=${userEmail} sigla=${sigla} unidades=${unidadesApagadas} templates_apagados=${templatesApagados} templates_preservados=${sharedPaths.size} storageErrors=${storageErrors}`,
    );

    return new Response(
      JSON.stringify({
        sigla,
        unidades: unidadesApagadas ?? 0,
        templatesApagados,
        templatesPreservados: sharedPaths.size,
        storageErrors,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("[admin-delete-empreendimento] Exception:", err);
    return new Response(
      JSON.stringify({ error: "Erro interno" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
});
