// Soter — Edge Function: enviar-assinatura
// Recebe o contrato (.docx em base64) + a lista de assinantes e cria um acordo
// no Adobe Acrobat Sign, disparando a assinatura. O Adobe converte o .docx em
// PDF automaticamente. Usa o refresh token guardado por `adobe-oauth-callback`.
//
// Segurança: CORS strict + JWT obrigatório (mesmo padrão das outras funções).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CLIENT_ID = Deno.env.get("ADOBE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("ADOBE_CLIENT_SECRET")!;
const API_BASE = Deno.env.get("ADOBE_API_BASE") || "https://api.na3.adobesign.com";

const ORIGENS_PERMITIDAS = new Set([
  "https://adngbijkqkuaqwggjllo.supabase.co",
  "https://soter-contratos-ps58ghmbn-leovillacamellos-projects.vercel.app",
  "https://soter-contratos.vercel.app",
]);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

interface Recipient {
  email: string;
  order?: number;       // ordem de assinatura (1 = primeiro)
  role?: string;        // SIGNER (padrão) | APPROVER | ...
}

// Garante um access token válido: usa o cache se ainda vale; senão renova com o
// refresh token e atualiza o cache.
async function getAccessToken(): Promise<{ access: string; api: string }> {
  const { data, error } = await supabaseAdmin
    .from("integracao_adobe").select("*").eq("id", "adobe").single();
  if (error || !data?.refresh_token) {
    throw new Error("Integração com o Adobe não está autorizada (refresh token ausente).");
  }
  const api = data.api_access_point || `${API_BASE}/`;
  const aindaVale = data.access_token && data.token_expira
    && new Date(data.token_expira).getTime() > Date.now() + 60_000;
  if (aindaVale) return { access: data.access_token, api };

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: data.refresh_token,
  });
  const r = await fetch(`${API_BASE}/oauth/v2/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Falha ao renovar token Adobe: ${r.status} ${t}`);
  }
  const tok = await r.json();
  const expira = new Date(Date.now() + (Number(tok.expires_in || 3600) * 1000)).toISOString();
  await supabaseAdmin.from("integracao_adobe")
    .update({ access_token: tok.access_token, token_expira: expira, updated_at: new Date().toISOString() })
    .eq("id", "adobe");
  return { access: tok.access_token, api };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = ORIGENS_PERMITIDAS.has(origin) ? origin : null;
  if (!allowedOrigin) return new Response("Forbidden", { status: 403 });

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  // 🔒 JWT obrigatório
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "Autenticação necessária" }, 401);
  const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(jwt);
  if (authError || !user) return json({ error: "Token inválido ou expirado" }, 401);

  let payload: { docx_base64?: string; file_name?: string; nome_acordo?: string; recipients?: Recipient[] };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body inválido" }, 400);
  }

  const { docx_base64, file_name, nome_acordo, recipients } = payload;
  if (!docx_base64) return json({ error: "docx_base64 ausente" }, 400);
  const dests = (recipients || []).filter((r) => r?.email && /\S+@\S+\.\S+/.test(r.email));
  if (dests.length === 0) return json({ error: "Nenhum destinatário com e-mail válido" }, 400);

  try {
    const { access, api } = await getAccessToken();

    // 1) Sobe o .docx como "transient document" (vale 7 dias no Adobe)
    const bytes = base64ToBytes(docx_base64);
    const form = new FormData();
    form.append(
      "File",
      new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
      file_name || "contrato.docx",
    );
    const tResp = await fetch(`${api}api/rest/v6/transientDocuments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access}` },
      body: form,
    });
    if (!tResp.ok) {
      const t = await tResp.text();
      console.error(`[enviar-assinatura] transientDocuments falhou: ${tResp.status} ${t}`);
      return json({ error: `Erro ao subir documento no Adobe: ${tResp.status}` }, 502);
    }
    const { transientDocumentId } = await tResp.json();

    // 2) Cria o acordo e dispara a assinatura
    const agreement = {
      fileInfos: [{ transientDocumentId }],
      name: nome_acordo || "Contrato Promessa de Compra e Venda",
      participantSetsInfo: dests.map((r, i) => ({
        memberInfos: [{ email: r.email }],
        order: r.order ?? (i + 1),
        role: r.role ?? "SIGNER",
      })),
      signatureType: "ESIGN",
      state: "IN_PROCESS",
    };
    const aResp = await fetch(`${api}api/rest/v6/agreements`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify(agreement),
    });
    if (!aResp.ok) {
      const t = await aResp.text();
      console.error(`[enviar-assinatura] agreements falhou: ${aResp.status} ${t}`);
      return json({ error: `Erro ao criar acordo no Adobe: ${aResp.status} ${t}` }, 502);
    }
    const ag = await aResp.json();

    console.log(`[enviar-assinatura] OK — user=${user.email} agreementId=${ag.id} dests=${dests.map((d) => d.email).join(",")}`);
    return json({ ok: true, agreementId: ag.id, destinatarios: dests.map((d) => d.email) });
  } catch (err) {
    console.error("[enviar-assinatura] Exception:", err);
    return json({ error: err instanceof Error ? err.message : "Erro interno" }, 500);
  }
});
