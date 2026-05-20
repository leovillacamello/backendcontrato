// Soter — Edge Function: admin-add-usuario
// Adiciona um usuário ao sistema (modelo "lista de convidados"). Faz as duas
// coisas server-side, de uma vez:
//   1. Cria a conta em auth.users (Admin API, e-mail já confirmado).
//   2. Insere o e-mail em usuarios_autorizados.
// Idempotente: chamar 2x com o mesmo e-mail não dá erro. Admin only.

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

interface AddRequest {
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
      JSON.stringify({ error: "Apenas administradores podem adicionar usuários" }),
      { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  // 3. Payload
  let body: AddRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Payload JSON inválido" }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
  const email = (body?.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return new Response(
      JSON.stringify({ error: "E-mail inválido" }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // 4. Cria a conta no Auth (e-mail confirmado — entra por magic link).
    //    Se já existir, segue em frente (idempotente).
    const { error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createErr) {
      const msg = createErr.message.toLowerCase();
      const jaExiste = msg.includes("already") || msg.includes("registered") || msg.includes("exists");
      if (!jaExiste) {
        console.error("[admin-add-usuario] Erro createUser:", createErr.message);
        return new Response(
          JSON.stringify({ error: `Falha ao criar conta: ${createErr.message}` }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }
    }

    // 5. Insere na lista de autorizados (ignora se já estiver).
    const { error: insErr } = await supabaseAdmin
      .from("usuarios_autorizados")
      .insert({ email });
    if (insErr && (insErr as { code?: string }).code !== "23505") {
      console.error("[admin-add-usuario] Erro insert:", insErr.message);
      return new Response(
        JSON.stringify({ error: `Conta criada, mas falhou ao autorizar: ${insErr.message}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    console.log(`[admin-add-usuario] OK — admin=${userEmail} adicionou=${email}`);
    return new Response(
      JSON.stringify({ ok: true, email }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("[admin-add-usuario] Exception:", err);
    return new Response(
      JSON.stringify({ error: "Erro interno" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
});
