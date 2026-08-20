// Cloudflare Pages Function - POST /api/send-briefing
// Emails one already-built briefing to the address the owner gives. This is
// NOT the automatic daily-cron send (that needs an always-on data source —
// still "Soon", see the sidebar). This is on-demand: "send me a copy of
// what I'm looking at right now."

import { checkFreeLimit } from "../_lib/access.js";

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function esc(s) { return String(s == null ? "" : s); }

// Mirrors app.html's briefingToText(), rebuilt server-side rather than
// trusting client-supplied free text — keeps this endpoint from doubling as
// an open mail relay for arbitrary content.
function briefingToText(b) {
  const s = b.summary || {}, w = b.why || {}, r = b.risk || {}, o = b.opportunity || {};
  const L = [];
  L.push(esc(s.headline)); L.push(""); L.push(esc(s.body)); L.push("");
  L.push("Business health: " + esc(s.health)); L.push("");
  L.push("WHAT CHANGED");
  (Array.isArray(b.what_changed) ? b.what_changed : []).slice(0, 8).forEach((m) => {
    L.push("- " + esc(m.metric) + " " + esc(m.value) + ": " + esc(m.explanation));
  });
  L.push(""); L.push("WHY IT HAPPENED"); L.push(esc(w.question));
  (Array.isArray(w.reasons) ? w.reasons : []).slice(0, 6).forEach((x, i) => L.push((i + 1) + ". " + esc(x)));
  L.push("Confidence: " + esc(w.confidence)); L.push("");
  L.push("RISK"); L.push(esc(r.title) + " " + esc(r.detail));
  if (r.action) L.push("Action: " + esc(r.action));
  L.push(""); L.push("OPPORTUNITY"); L.push(esc(o.title) + " " + esc(o.detail));
  if (o.recommendation) L.push("Recommendation: " + esc(o.recommendation));
  L.push(""); L.push("RECOMMENDATIONS");
  (Array.isArray(b.recommendations) ? b.recommendations : []).slice(0, 6).forEach((x, i) => {
    L.push((i + 1) + ". " + esc(x.title) + " (" + esc(x.effort) + "): " + esc(x.reason));
  });
  L.push(""); L.push("Generated with Vyrlo, vyrlo.cc");
  return L.join("\n");
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.RESEND_API_KEY) return json({ error: "Email isn't set up yet." }, 500);

    const body = await request.json().catch(() => ({}));
    const email = String(body.email || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That doesn't look like a valid email." }, 400);
    if (!body.briefing || typeof body.briefing !== "object") return json({ error: "No briefing to send." }, 400);

    // Per-IP daily cap so this can't become a spam relay for arbitrary
    // addresses — cheap to send, but abuse risk is reputational, not cost.
    if (!(await checkFreeLimit(env, request, "sendmail", 5))) {
      return json({ error: "Too many emails sent today — try again tomorrow." }, 429);
    }

    const headline = String((body.briefing.summary && body.briefing.summary.headline) || "Today's briefing").slice(0, 200);
    const text = briefingToText(body.briefing).slice(0, 8000);

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "authorization": "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.RESEND_FROM || "Vyrlo <briefing@vyrlo.cc>",
        to: [email],
        subject: headline,
        text
      })
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return json({ error: "Couldn't send that email.", detail: detail.slice(0, 300) }, 502);
    }

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: "Something broke sending that email.", detail: String(e).slice(0, 200) }, 500);
  }
}
