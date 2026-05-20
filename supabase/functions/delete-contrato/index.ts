// Soter — Edge Function: delete-contrato
// Exclui um único registro do histórico (linha em historico_contratos +
// arquivo .docx no Storage). Autorização server-side: o DONO do contrato
// (user_id) ou um administrador.
// Necessária porque authenticated não tem mais GRANT de DELETE direto.

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

interface DeleteRequest {
  id: string | number;
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

  // 1. Autenticação
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

  // 2. Payload
  let body: DeleteRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Payload JSON inválido" }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
  if (body?.id === undefined || body?.id === null || body.id === "") {
    return new Response(
      JSON.stringify({ error: "Campo obrigatório: id" }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // 3. Busca o contrato — precisa do user_id (autorização) e storage_path
    const { data: row, error: fetchErr } = await supabaseAdmin
      .from("historico_contratos")
      .select("id, user_id, storage_path")
      .eq("id", body.id)
      .maybeSingle();

    if (fetchErr) {
      console.error("[delete-contrato] Erro fetch:", fetchErr.message);
      return new Response(
        JSON.stringify({ error: `Falha ao buscar contrato: ${fetchErr.message}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }
    if (!row) {
      return new Response(
        JSON.stringify({ error: "Contrato não encontrado" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // 4. Autorização: dono do contrato OU admin
    const userEmail = (user.email ?? "").toLowerCase();
    const isAdmin = ADMIN_EMAILS.has(userEmail);
    const isOwner = row.user_id && row.user_id === user.id;
    if (!isAdmin && !isOwner) {
      console.warn(`[delete-contrato] Negado — user=${userEmail} tentou excluir contrato ${body.id} de outro usuário`);
      return new Response(
        JSON.stringify({ error: "Você só pode excluir contratos que você gerou" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // 5. Remove o arquivo do Storage (se houver)
    if (row.storage_path) {
      const { error: rmErr } = await supabaseAdmin.storage.from("contratos").remove([row.storage_path]);
      if (rmErr) {
        // Não bloqueia a exclusão do registro — só loga.
        console.error("[delete-contrato] Erro storage:", rmErr.message);
      }
    }

    // 6. Apaga o registro
    const { error: delErr } = await supabaseAdmin
      .from("historico_contratos")
      .delete()
      .eq("id", body.id);
    if (delErr) {
      console.error("[delete-contrato] Erro delete:", delErr.message);
      return new Response(
        JSON.stringify({ error: `Falha ao excluir: ${delErr.message}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    console.log(`[delete-contrato] OK — user=${userEmail} contrato=${body.id} (admin=${isAdmin})`);
    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("[delete-contrato] Exception:", err);
    return new Response(
      JSON.stringify({ error: "Erro interno" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
});
