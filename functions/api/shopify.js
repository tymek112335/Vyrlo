// Cloudflare Pages Function - POST /api/shopify
//
// Pulls a store's recent orders, aggregates them into a numbers summary, and
// runs that through the briefing engine (/api/generate).
//
// Credentials are per-customer: the owner pastes their own shop domain and a
// custom-app Admin API token in the app, and the browser sends them with each
// request. Nothing store-specific is stored server-side by this endpoint —
// the daily-email job is the only thing that keeps a copy, and only for
// people who explicitly turn it on (see /api/daily).
//
// The old single-store env vars (SHOPIFY_SHOP / SHOPIFY_TOKEN) still work,
// but ONLY for the owner's own ACCESS_CODE — that pairing used to be the
// whole auth model, and leaving it reachable by any valid code would have
// served the owner's store data to paying customers.
//
// Modes:
//   {mode:"test"}  → verify the credentials, return the store name
//   default        → pull the numbers and build a briefing

import { isValidCode, checkFreeLimit } from "../_lib/access.js";
import { normalizeShop, pullStoreNumbers, testConnection, resolveToken } from "../_lib/shopify.js";

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json().catch(() => ({}));
    const code = String(body.accessCode || "").trim();
    const paid = await isValidCode(env, code);
    const isOwner = !!(env.ACCESS_CODE && code === env.ACCESS_CODE);

    // Resolve which store to pull from. Post-2026 apps send clientId +
    // clientSecret and get a 24h token minted here; pre-2026 custom apps send
    // the permanent token they already hold.
    let shop = normalizeShop(body.shop);
    let token = null;
    if (shop) {
      try {
        token = await resolveToken(shop, body);
      } catch (e) {
        return json({ error: "Shopify wouldn't accept this store connection. Reconnect from Shopify Connect.", detail: String(e).slice(0, 200) }, 400);
      }
    }

    if (!shop || !token) {
      // No usable credentials — fall back to the owner's env-configured
      // store, and only for the owner.
      if (!isOwner) {
        return json({ error: "Connect your Shopify store first, under Shopify Connect." }, 400);
      }
      shop = normalizeShop(env.SHOPIFY_SHOP);
      token = String(env.SHOPIFY_TOKEN || "").trim() || null;
      if (!shop || !token) {
        return json({ error: "No Shopify store is connected." }, 400);
      }
    } else if (!paid) {
      // Anyone can connect their own store and try it, but not on repeat —
      // each pull is a real model call. Paid codes skip the cap.
      if (!(await checkFreeLimit(env, request, "shopify", 2))) {
        return json({ error: "You've used today's free Shopify briefings. Enter an access code for unlimited pulls." }, 429);
      }
    }

    if (body.mode === "test") {
      try {
        const info = await testConnection(shop, token);
        return json({ ok: true, name: info.name, tz: info.tz }, 200);
      } catch (e) {
        const msg = String(e);
        // Reaching here means the credentials were good enough to get a
        // token and the store then refused the read — which is a scope or
        // install problem, not a wrong-key problem. Saying "bad token" here
        // sent the owner back to re-copy a key that was already correct.
        if (/401|403/.test(msg)) {
          return json({
            error: "Shopify refused to return store data. Vyrlo's access was probably removed on the store — reconnect from Shopify Connect.",
            detail: msg.slice(0, 300)
          }, 400);
        }
        if (/404/.test(msg)) return json({ error: "That store domain doesn't exist. It should look like yourstore.myshopify.com." }, 400);
        return json({ error: "Couldn't reach that store.", detail: msg.slice(0, 300) }, 400);
      }
    }

    const pulled = await pullStoreNumbers(shop, token);

    // Run it through the briefing engine.
    const origin = new URL(request.url).origin;
    const gen = await fetch(`${origin}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rawText: pulled.raw,
        period: pulled.period,
        profile: body.profile,
        openActions: body.openActions,
        watchlist: body.watchlist,
        accessCode: code
      })
    });
    if (!gen.ok) {
      const d = await gen.text();
      return json({ error: "Briefing engine error on Shopify data.", detail: d.slice(0, 300) }, 502);
    }
    const briefing = await gen.json();
    if (briefing.error) return json({ error: briefing.error }, 502);

    return json({ briefing, rawText: pulled.raw, shop, period: pulled.period }, 200);
  } catch (e) {
    const msg = String(e);
    if (/401|403/.test(msg)) {
      return json({ error: "Shopify rejected your token. Reconnect your store under Shopify Connect." }, 400);
    }
    return json({ error: "Shopify pull failed.", detail: msg.slice(0, 300) }, 500);
  }
}
