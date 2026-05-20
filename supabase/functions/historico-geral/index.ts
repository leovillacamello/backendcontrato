// Soter — Edge Function: historico-geral
// Retorna o histórico de contratos de TODOS os empreendimentos e TODOS os
// usuários. A RLS de historico_contratos limita cada usuário aos próprios
// registros — esta função usa service_role para a visão completa.
// Acesso: qualquer usuário autenticado (decisão de produto: transparência interna).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ORIGENS_PERMITIDAS = new Set([
  "https://adngbijkqkuaqwggjllo.supabase.co",
  "https://soter-contratos-ps58ghmbn-leovillacamellos-projects.vercel.app",
  "https://soter-contratos.vercel.app",
]);

const MAX_ROWS = 1000;

interface HistoricoRequest {
  dateFrom?: string; // 'YYYY-MM-DD' (opcional)
  dateTo?: string;   // 'YYYY-MM-DD' (opcional)
}

serve(async (req) => {
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

  // Autenticação: JWT obrigatório (qualquer usuário autenticado)
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

  let body: HistoricoRequest = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    /* body vazio é ok */
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  try {
    let query = supabaseAdmin
      .from("historico_contratos")
      .select("id, sigla, bloco, unidade, comprador, valor_total, tipo_comissao, created_at, nome_arquivo, storage_path, user_email")
      .order("created_at", { ascending: false });

    // Datas em horário de Brasília (UTC-3) — mesmo padrão do HistoryView.
    if (body.dateFrom) {
      query = query.gte("created_at", new Date(body.dateFrom + "T00:00:00-03:00").toISOString());
    }
    if (body.dateTo) {
      query = query.lte("created_at", new Date(body.dateTo + "T23:59:59-03:00").toISOString());
    }
    if (!body.dateFrom && !body.dateTo) {
      query = query.limit(MAX_ROWS);
    }

    const { data, error } = await query;
    if (error) {
      console.error("[historico-geral] Erro:", error.message);
      return new Response(
        JSON.stringify({ error: `Falha ao buscar histórico: ${error.message}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    return new Response(
      JSON.stringify({ contratos: data ?? [] }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("[historico-geral] Exception:", err);
    return new Response(
      JSON.stringify({ error: "Erro interno" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
});
