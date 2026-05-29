// Soter — Edge Function: adobe-oauth-callback
// Faz a "dança" OAuth do Adobe Acrobat Sign UMA vez e guarda o refresh token.
//
// É PÚBLICA (deploy com --no-verify-jwt): o Adobe redireciona o navegador pra
// cá, sem JWT do Supabase. Por isso a fase de início é protegida por um segredo
// (ADOBE_SETUP_SECRET) e o retorno é validado por `state` (anti-CSRF).
//
// Fluxo (tudo no navegador do admin, uma vez só):
//   1. Admin abre  .../adobe-oauth-callback?setup=<SEGREDO>
//      → gera `state`, guarda no banco e redireciona pro Adobe autorizar.
//   2. Adobe volta em .../adobe-oauth-callback?code=...&state=...
//      → troca o code por tokens e guarda o refresh_token.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CLIENT_ID = Deno.env.get("ADOBE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("ADOBE_CLIENT_SECRET")!;
const SETUP_SECRET = Deno.env.get("ADOBE_SETUP_SECRET")!;
const REDIRECT_URI = Deno.env.get("ADOBE_REDIRECT_URI")
  || "https://adngbijkqkuaqwggjllo.supabase.co/functions/v1/adobe-oauth-callback";
// Host pra autorizar (tela de login/consent do Adobe) e host de API (token).
const OAUTH_WEB_BASE = Deno.env.get("ADOBE_OAUTH_WEB_BASE") || "https://soterengenharia.na3.adobesign.com";
const API_BASE = Deno.env.get("ADOBE_API_BASE") || "https://api.na3.adobesign.com";
// Modificador "self" (padrão) = age em nome do próprio usuário que autorizar.
// Não exige Account Admin (diferente de ":account").
const SCOPES = Deno.env.get("ADOBE_SCOPES")
  || "agreement_send agreement_write agreement_read webhook_write webhook_read";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function htmlPage(titulo: string, msg: string, ok: boolean): Response {
  // O Supabase serve esta URL como text/plain (não deixa servir HTML). Então
  // mandamos texto puro ASCII (sem acento/emoji) pra não aparecer tag crua nem
  // caractere quebrado. `normalize NFD` + remoção de não-ASCII tira os acentos.
  const ascii = (s: string) => s.normalize("NFD").replace(/[^\x20-\x7E\n]/g, "");
  const headers = new Headers();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(`${ascii(titulo)}\n\n${ascii(msg)}\n`, { status: ok ? 200 : 400, headers });
}

serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const erro = url.searchParams.get("error");
  const state = url.searchParams.get("state");

  // Adobe recusou / erro no consentimento
  if (erro) {
    console.warn(`[adobe-oauth] erro do Adobe: ${erro} — ${url.searchParams.get("error_description") || ""}`);
    return htmlPage("Autorização não concluída", `O Adobe retornou: ${erro}. Tente novamente.`, false);
  }

  // ── Fase 2: retorno do Adobe com o código ──────────────────────────────────
  if (code) {
    // valida o state contra o que guardamos (anti-CSRF / evita conta errada)
    const { data: row } = await supabaseAdmin
      .from("integracao_adobe").select("oauth_state").eq("id", "adobe").single();
    if (!state || !row?.oauth_state || state !== row.oauth_state) {
      console.warn("[adobe-oauth] state inválido no callback");
      return htmlPage("Falha de segurança", "O código de verificação (state) não confere. Reinicie a autorização.", false);
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
    });
    const resp = await fetch(`${API_BASE}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error(`[adobe-oauth] troca de token falhou: ${resp.status} ${txt}`);
      return htmlPage("Erro ao obter token", "Não foi possível trocar o código por um token. Confira Client Id/Secret.", false);
    }
    const tok = await resp.json();
    const expira = new Date(Date.now() + (Number(tok.expires_in || 3600) * 1000)).toISOString();

    const { error: upErr } = await supabaseAdmin
      .from("integracao_adobe")
      .update({
        refresh_token: tok.refresh_token,
        access_token: tok.access_token,
        token_expira: expira,
        api_access_point: tok.api_access_point || `${API_BASE}/`,
        web_access_point: tok.web_access_point || null,
        oauth_state: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", "adobe");
    if (upErr) {
      console.error(`[adobe-oauth] erro ao salvar token: ${upErr.message}`);
      return htmlPage("Erro ao salvar", "O token foi obtido mas não pôde ser salvo. Veja os logs.", false);
    }

    console.log("[adobe-oauth] OK — refresh token armazenado.");
    return htmlPage("Tudo certo! ✅", "A integração com o Adobe Sign foi autorizada. Pode fechar esta aba.", true);
  }

  // ── Fase 1: início — exige o segredo de setup ──────────────────────────────
  const setup = url.searchParams.get("setup");
  if (!setup || setup !== SETUP_SECRET) {
    return htmlPage("Acesso negado", "Esta página é só para configuração interna.", false);
  }

  const novoState = crypto.randomUUID();
  const { error: stErr } = await supabaseAdmin
    .from("integracao_adobe")
    .update({ oauth_state: novoState, updated_at: new Date().toISOString() })
    .eq("id", "adobe");
  if (stErr) {
    console.error(`[adobe-oauth] erro ao gravar state: ${stErr.message}`);
    return htmlPage("Erro", "Não foi possível iniciar a autorização (banco). Rodou o SQL da tabela?", false);
  }

  const authUrl = `${OAUTH_WEB_BASE}/public/oauth/v2?` + new URLSearchParams({
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    scope: SCOPES,
    state: novoState,
  }).toString();

  return new Response(null, { status: 302, headers: { Location: authUrl } });
});
