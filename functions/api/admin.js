// Cloudflare Pages Function - POST /api/admin
//
// Issues access codes by hand, for customers invoiced directly rather than
// paid through Stripe. Founding-customer flow: they email, get an invoice,
// transfer the money, and get a code that works for a month.
//
// Auth is ADMIN_SECRET, deliberately NOT the owner's ACCESS_CODE. That one is
// typed into the app and kept in a browser's localStorage; the credential
// that mints paid access shouldn't be the same one that logs in.
//
// Actions: create | list | revoke

import { issueManualCode } from "../_lib/access.js";

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function secretMatches(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json().catch(() => ({}));

    if (!env.ADMIN_SECRET) return json({ error: "ADMIN_SECRET isn't set on the server." }, 503);
    if (!secretMatches(body.secret, env.ADMIN_SECRET)) return json({ error: "Wrong admin password." }, 403);
    if (!env.VYRLO_KV) return json({ error: "No KV bound." }, 503);

    if (body.action === "create") {
      const issued = await issueManualCode(env, body.label, body.days);
      return json({ ok: true, ...issued }, 200);
    }

    if (body.action === "list") {
      const out = [];
      let cursor;
      do {
        const page = await env.VYRLO_KV.list({ prefix: "code:", cursor });
        cursor = page.list_complete ? null : page.cursor;
        for (const k of page.keys) {
          const code = k.name.slice("code:".length);
          const raw = await env.VYRLO_KV.get(k.name);
          let rec = {};
          try { rec = JSON.parse(raw); } catch (e) { rec = { label: "(Stripe or legacy)", legacy: true }; }
          out.push({ code, ...rec });
        }
      } while (cursor && out.length < 200);
      out.sort((a, b) => String(b.issued || "").localeCompare(String(a.issued || "")));
      return json({ ok: true, codes: out }, 200);
    }

    if (body.action === "revoke") {
      const code = String(body.code || "").trim();
      if (!code) return json({ error: "Which code?" }, 400);
      await env.VYRLO_KV.delete("code:" + code);
      return json({ ok: true }, 200);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: "Admin call failed.", detail: String(e).slice(0, 200) }, 500);
  }
}
