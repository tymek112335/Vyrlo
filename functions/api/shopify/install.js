// Cloudflare Pages Function - GET /api/shopify/install?shop=<store>.myshopify.com
//
// Step one of the merchant install: send them to Shopify's consent screen.
// A one-time state nonce is parked in KV so the callback can prove the
// redirect it receives belongs to a flow this server actually started.

import { SCOPES, randomId } from "../../_lib/oauth.js";
import { normalizeShop } from "../../_lib/shopify.js";

function fail(message) {
  // This endpoint is reached by a browser redirect, not fetch, so errors have
  // to be readable on a page rather than returned as JSON nobody will see.
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Vyrlo</title>` +
    `<body style="font:16px/1.6 system-ui;padding:40px;max-width:34rem;margin:auto">` +
    `<h1 style="font-size:20px">Couldn't start the Shopify connection</h1><p>${message}</p>` +
    `<p><a href="/app">Back to Vyrlo</a></p></body>`,
    { status: 400, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const shop = normalizeShop(url.searchParams.get("shop"));
  if (!shop) return fail("That doesn't look like a myshopify.com store domain.");

  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    return fail("Shopify isn't configured on this server yet.");
  }
  if (!env.VYRLO_KV) return fail("Shopify isn't configured on this server yet.");

  const state = randomId();
  await env.VYRLO_KV.put("oauthstate:" + state, shop, { expirationTtl: 600 });

  const redirectUri = url.origin + "/api/shopify/callback";
  const authorize =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(env.SHOPIFY_CLIENT_ID)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  return Response.redirect(authorize, 302);
}
