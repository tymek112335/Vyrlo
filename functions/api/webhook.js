// Stripe webhook receiver. No Stripe SDK (edge-runtime friendly) — signature
// verification is done by hand with Web Crypto, following Stripe's documented
// scheme: HMAC-SHA256 over "{timestamp}.{raw body}", compared to the v1 value
// in the Stripe-Signature header.

import { revokeByCustomer } from "../_lib/access.js";

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => p.split("=").map((s) => s.trim()))
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(timestamp + "." + rawBody)
  );
  const expected = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expected, v1);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "Webhook not configured." }, 500);

  const sigHeader = request.headers.get("stripe-signature");
  const rawBody = await request.text();
  if (!sigHeader || !(await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: "Invalid signature." }, 400);
  }

  const event = JSON.parse(rawBody);

  if (event.type === "customer.subscription.deleted") {
    const customerId = event.data.object.customer;
    if (customerId && env.VYRLO_KV) await revokeByCustomer(env, customerId);
  }

  return json({ received: true }, 200);
}
