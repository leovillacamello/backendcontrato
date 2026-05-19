// Soter — Edge Function: admin-clear-history
// Apaga TODO o histórico de contratos (DB + Storage). Autorização server-side:
// só roda se o JWT pertencer a um admin. Frontend não precisa nem deve saber
// disso — o check `user.email === 'adm@...'` na UI é só cosmético.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ADMIN_EMAILS = new Set([
  "adm@soter.com.br",
]);

// Mesmas origens permitidas do gerar-contrato — mantenas em sincronia.
const ORIGENS_PERMITIDAS = new Set([
  "https://adngbijkqkuaqwggjllo.supabase.co",
  "https://soter-contratos-ps58ghmbn-leovillacamellos-projects.vercel.app",
  "https://soter-contratos.vercel.app",
]);

const STORAGE_BATCH_SIZE = 100;

serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = ORIGENS_PERMITIDAS.has(origin) ? origin : (origin ? null : "*");

  if (allowedOrigin === null) {
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

  // 🔒 1. Autenticação: JWT obrigatório
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

  // 🔒 2. Autorização: precisa ser admin
  const userEmail = (user.email ?? "").toLowerCase();
  if (!ADMIN_EMAILS.has(userEmail)) {
    console.warn(`[admin-clear-history] Negado para ${userEmail} (user_id=${user.id})`);
    return new Response(
      JSON.stringify({ error: "Apenas administradores podem executar esta ação" }),
      { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  // 🔧 3. Operações com service_role (bypassa RLS)
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // 3a. Coleta paths do Storage
    const { data: rows, error: fetchErr } = await supabaseAdmin
      .from("historico_contratos")
      .select("storage_path")
      .not("storage_path", "is", null)
      .neq("storage_path", "");

    if (fetchErr) {
      console.error("[admin-clear-history] Erro fetch:", fetchErr.message);
      return new Response(
        JSON.stringify({ error: `Falha ao buscar registros: ${fetchErr.message}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    const paths = (rows ?? [])
      .map((r) => (r as { storage_path: string }).storage_path)
      .filter(Boolean);

    // 3b. Remove arquivos do Storage em lotes
    let storageErrors = 0;
    for (let i = 0; i < paths.length; i += STORAGE_BATCH_SIZE) {
      const batch = paths.slice(i, i + STORAGE_BATCH_SIZE);
      const { error: rmErr } = await supabaseAdmin.storage.from("contratos").remove(batch);
      if (rmErr) {
        storageErrors++;
        console.error(`[admin-clear-history] Erro storage lote ${i}:`, rmErr.message);
      }
    }

    // 3c. Apaga todos os registros do DB
    const { error: delErr, count } = await supabaseAdmin
      .from("historico_contratos")
      .delete({ count: "exact" })
      .not("id", "is", null);

    if (delErr) {
      console.error("[admin-clear-history] Erro delete:", delErr.message);
      return new Response(
        JSON.stringify({ error: `Falha ao apagar histórico: ${delErr.message}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    console.log(
      `[admin-clear-history] OK — admin=${userEmail} count=${count} paths=${paths.length} storageErrors=${storageErrors}`,
    );

    return new Response(
      JSON.stringify({ count: count ?? 0, paths: paths.length, storageErrors }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("[admin-clear-history] Exception:", err);
    return new Response(
      JSON.stringify({ error: "Erro interno" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
});
