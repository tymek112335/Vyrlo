// Creates a Stripe Checkout Session for the Vyrlo monthly subscription.
// Raw fetch against the Stripe REST API — same style as the Anthropic calls
// in generate.js — no Stripe SDK, so nothing edge-runtime-incompatible.

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const reqBody = await request.json().catch(() => ({}));
  const plan = reqBody.plan === "business" ? "business" : "pro";
  const priceId = plan === "business" ? env.STRIPE_PRICE_ID_BUSINESS : env.STRIPE_PRICE_ID;

  if (!env.STRIPE_SECRET_KEY || !priceId) {
    return json({ error: "Payments aren't configured yet." }, 500);
  }

  const origin = "https://vyrlo.cc";
  const body = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: origin + "/app?paid_session={CHECKOUT_SESSION_ID}",
    cancel_url: origin + "/app"
  });

  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "authorization": "Bearer " + env.STRIPE_SECRET_KEY,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  if (!resp.ok) {
    const detail = await resp.text();
    return json({ error: "Couldn't start checkout.", detail }, 502);
  }

  const session = await resp.json();
  return json({ url: session.url }, 200);
}
