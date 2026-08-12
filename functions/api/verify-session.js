// Confirms a completed Stripe Checkout Session and issues (or reuses) the
// customer's permanent access code. This is what makes the app unlock
// immediately on the success redirect, without waiting on the webhook.

import { issueCode } from "../_lib/access.js";

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Payments aren't configured yet." }, 500);
  if (!env.VYRLO_KV) return json({ error: "Payments aren't configured yet." }, 500);

  const reqBody = await request.json().catch(() => ({}));
  const sessionId = String(reqBody.session_id || "").trim();
  if (!sessionId) return json({ error: "Missing session id." }, 400);

  const resp = await fetch(
    "https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(sessionId),
    { headers: { "authorization": "Bearer " + env.STRIPE_SECRET_KEY } }
  );
  if (!resp.ok) {
    const detail = await resp.text();
    return json({ error: "Couldn't verify that session.", detail }, 502);
  }

  const session = await resp.json();
  if (session.payment_status !== "paid" || !session.customer) {
    return json({ ok: false, error: "That checkout hasn't completed yet." }, 200);
  }

  const code = await issueCode(env, session.customer);
  return json({ ok: true, code }, 200);
}
