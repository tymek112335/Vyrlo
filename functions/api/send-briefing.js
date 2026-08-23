// Cloudflare Pages Function - POST /api/send-briefing
// Emails one already-built briefing to the address the owner gives. This is
// the on-demand send: "send me a copy of what I'm looking at right now."
// The automatic morning send is /api/cron, driven by /api/daily.

import { checkFreeLimit } from "../_lib/access.js";
import { briefingToText, sendMail } from "../_lib/email.js";

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
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
    const alerts = Array.isArray(body.alerts) ? body.alerts.map((a) => String(a).slice(0, 200)) : [];
    const text = briefingToText(body.briefing, { alerts }).slice(0, 8000);

    try {
      await sendMail(env, email, headline, text);
    } catch (e) {
      return json({ error: "Couldn't send that email.", detail: String(e).slice(0, 300) }, 502);
    }

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: "Something broke sending that email.", detail: String(e).slice(0, 200) }, 500);
  }
}
