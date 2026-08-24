// Cloudflare Pages Function - GET /api/shopify/callback
//
// Step two: Shopify sends the merchant back here with a one-time code. Verify
// the request is genuinely from Shopify (HMAC) and genuinely ours (state),
// swap the code for a permanent offline token, then hand that token to the
// browser through a short-lived one-time claim.
//
// The handoff exists to keep Vyrlo's promise that store credentials live in
// the merchant's own browser: the server holds the token for a few minutes at
// most, and only keeps a copy afterwards if they switch on the daily email.

import { verifyHmac, exchangeCode, randomId } from "../../_lib/oauth.js";
import { normalizeShop, testConnection } from "../../_lib/shopify.js";

function page(title, body, status) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Vyrlo</title>` +
    `<body style="font:16px/1.6 system-ui;padding:40px;max-width:34rem;margin:auto">` +
    `<h1 style="font-size:20px">${title}</h1>${body}` +
    `<p><a href="/app">Back to Vyrlo</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET || !env.VYRLO_KV) {
    return page("Not configured", "<p>Shopify isn't set up on this server yet.</p>", 500);
  }

  const shop = normalizeShop(url.searchParams.get("shop"));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!shop || !code || !state) {
    return page("Something's missing", "<p>Shopify didn't send everything needed to finish the connection. Try again from Vyrlo.</p>", 400);
  }

  // Both checks matter and neither replaces the other: the HMAC proves Shopify
  // sent this, the state proves we asked for it.
  if (!(await verifyHmac(request.url, env.SHOPIFY_CLIENT_SECRET))) {
    return page("Couldn't verify that request", "<p>The signature on Shopify's response didn't check out, so nothing was connected.</p>", 400);
  }
  const stateKey = "oauthstate:" + state;
  const expectedShop = await env.VYRLO_KV.get(stateKey);
  await env.VYRLO_KV.delete(stateKey); // one use, whatever happens next
  if (!expectedShop || expectedShop !== shop) {
    return page("That link has expired", "<p>Start the connection again from Vyrlo — the install link is only good for a few minutes.</p>", 400);
  }

  let token;
  try {
    token = await exchangeCode(shop, env.SHOPIFY_CLIENT_ID, env.SHOPIFY_CLIENT_SECRET, code);
  } catch (e) {
    return page("Shopify wouldn't finish the connection", `<p>${String(e).slice(0, 200)}</p>`, 502);
  }

  let name = shop;
  try { name = (await testConnection(shop, token)).name || shop; } catch (e) {}

  // One-time handoff so the token reaches the browser without ever sitting in
  // a URL, where it would land in history and any referrer header.
  const claim = randomId();
  await env.VYRLO_KV.put("claim:" + claim, JSON.stringify({ shop, token, name }), { expirationTtl: 300 });

  return Response.redirect(url.origin + "/app?connected=" + claim, 302);
}
