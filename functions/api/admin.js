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
// Actions: create | list | revoke | overview

import { issueManualCode, saveCustomer, listCustomers, getStats, getUsage, PRO_MONTHLY } from "../_lib/access.js";

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
      // The permanent half of the record, so this customer still exists in
      // the list after the code they were given has expired.
      await saveCustomer(env, issued.label, issued.code, issued.expires);
      return json({ ok: true, ...issued }, 200);
    }

    if (body.action === "overview") {
      const [stats, customers] = await Promise.all([getStats(env, 30), listCustomers(env)]);

      // A customer is live if the code they hold is still in KV; the code
      // record self-deletes on expiry, so its absence is the lapse signal.
      const live = [];
      for (const c of customers) {
        const active = c.code ? !!(await env.VYRLO_KV.get("code:" + c.code)) : false;
        const usage = c.code && active ? await getUsage(env, c.code) : { total: 0 };
        live.push({
          id: c.id, label: c.label, code: c.code, expires: c.expires,
          created: c.created, active, used: usage.total, issues: (c.issues || []).length
        });
      }
      live.sort((a, b) => (b.active - a.active) || String(b.created || "").localeCompare(String(a.created || "")));

      const sum = (f, n) => stats.slice(-n).reduce((t, d) => t + (d[f] || 0), 0);
      return json({
        ok: true,
        limit: PRO_MONTHLY,
        stats,
        customers: live,
        totals: {
          activeCustomers: live.filter((c) => c.active).length,
          lapsedCustomers: live.filter((c) => !c.active).length,
          briefings30: sum("briefings_free", 30) + sum("briefings_paid", 30),
          briefingsPaid30: sum("briefings_paid", 30),
          briefings7: sum("briefings_free", 7) + sum("briefings_paid", 7),
          views30: sum("views_site", 30),
          appViews30: sum("views_app", 30),
          chat30: sum("chat", 30),
          emails30: sum("emails", 30)
        }
      }, 200);
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
