// Soter — Edge Function: admin-remove-usuario
// Remove um usuário do sistema, server-side:
//   1. Remove o e-mail de usuarios_autorizados.
//   2. Apaga a conta de auth.users (Admin API).
// Admin only. Não permite remover o próprio admin.

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

interface RemoveRequest {
  email: string;
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

  // 2. Autorização: admin only
  const userEmail = (user.email ?? "").toLowerCase();
  if (!ADMIN_EMAILS.has(userEmail)) {
    return new Response(
      JSON.stringify({ error: "Apenas administradores podem remover usuários" }),
      { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  // 3. Payload
  let body: RemoveRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Payload JSON inválido" }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
  const email = (body?.email || "").trim().toLowerCase();
  if (!email) {
    return new Response(
      JSON.stringify({ error: "Campo obrigatório: email" }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
  if (ADMIN_EMAILS.has(email)) {
    return new Response(
      JSON.stringify({ error: "Não é possível remover o administrador" }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // 4. Remove da lista de autorizados
    const { error: delErr } = await supabaseAdmin
      .from("usuarios_autorizados")
      .delete()
      .eq("email", email);
    if (delErr) {
      console.error("[admin-remove-usuario] Erro delete tabela:", delErr.message);
      return new Response(
        JSON.stringify({ error: `Falha ao remover da lista: ${delErr.message}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // 5. Apaga a conta do Auth (se existir). Acha o id pelo e-mail.
    const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (listErr) {
      console.warn("[admin-remove-usuario] Falha ao listar Auth:", listErr.message);
      // Removido da lista mesmo assim — conta órfã pode ser limpa depois.
    } else {
      const alvo = list.users.find((u) => (u.email ?? "").toLowerCase() === email);
      if (alvo) {
        const { error: delAuthErr } = await supabaseAdmin.auth.admin.deleteUser(alvo.id);
        if (delAuthErr) {
          console.warn("[admin-remove-usuario] Falha ao apagar conta Auth:", delAuthErr.message);
        }
      }
    }

    console.log(`[admin-remove-usuario] OK — admin=${userEmail} removeu=${email}`);
    return new Response(
      JSON.stringify({ ok: true, email }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("[admin-remove-usuario] Exception:", err);
    return new Response(
      JSON.stringify({ error: "Erro interno" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
});
