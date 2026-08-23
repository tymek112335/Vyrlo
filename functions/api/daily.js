// Cloudflare Pages Function - POST /api/daily
//
// The subscription record behind the automatic morning briefing. This is the
// only place Vyrlo keeps anything about a customer server-side, and it exists
// for one reason: an email that arrives at 7am has to be built while nobody
// is at the keyboard, so the job needs its own copy of the store credentials.
//
// Stored in VYRLO_KV as daily:<accessCode>. The Shopify credential — a client
// secret for post-2026 apps, a legacy token for older ones — is encrypted
// (see _lib/crypto.js); nothing is stored at all if TOKEN_SECRET is missing.
//
// Actions: {action:"get"|"save"|"delete"}

import { isValidCode } from "../_lib/access.js";
import { encryptSecret } from "../_lib/crypto.js";
import { normalizeShop, testConnection, resolveToken } from "../_lib/shopify.js";

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// What the browser is allowed to see back: never the token, encrypted or not.
function publicView(rec) {
  if (!rec) return null;
  return {
    on: true,
    email: rec.email,
    shop: rec.shop,
    hourUtc: rec.hourUtc,
    localTime: rec.localTime || "",
    lastSent: rec.lastSent || null,
    lastError: rec.lastError || null
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json().catch(() => ({}));
    const code = String(body.accessCode || "").trim();

    if (!(await isValidCode(env, code))) {
      return json({ error: "The daily email is part of a paid plan — enter your access code to switch it on." }, 403);
    }
    if (!env.VYRLO_KV) {
      return json({ error: "Daily email isn't switched on for this account yet." }, 503);
    }

    const key = "daily:" + code;

    if (body.action === "get") {
      const raw = await env.VYRLO_KV.get(key);
      return json({ ok: true, subscription: raw ? publicView(JSON.parse(raw)) : null }, 200);
    }

    if (body.action === "delete") {
      await env.VYRLO_KV.delete(key);
      return json({ ok: true, subscription: null }, 200);
    }

    if (body.action !== "save") return json({ error: "Unknown action." }, 400);

    if (!env.TOKEN_SECRET) {
      return json({ error: "Daily email isn't switched on for this account yet." }, 503);
    }

    const email = String(body.email || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That doesn't look like a valid email." }, 400);

    const shop = normalizeShop(body.shop);
    const legacyToken = String(body.token || "").trim();
    const clientId = String(body.clientId || "").trim();
    const clientSecret = String(body.clientSecret || "").trim();
    if (!shop || (!legacyToken && !(clientId && clientSecret))) {
      return json({ error: "The daily email needs your Shopify store connected — there has to be fresh data to brief on each morning." }, 400);
    }

    // hourUtc is computed in the browser from the owner's chosen local time
    // and their current UTC offset. It is not re-derived here, so a store in
    // a DST-observing country drifts by an hour twice a year until they
    // re-save. Being an hour off on a morning email is a fair trade for not
    // shipping a timezone database.
    const hourUtc = Math.min(23, Math.max(0, parseInt(body.hourUtc, 10) || 0));

    // Verify the credentials before promising to use them every morning —
    // a subscription that 401s daily is worse than one that never starts.
    // For post-2026 apps this also proves the client-credentials exchange
    // works, which is the part that has to keep working unattended.
    try {
      const probe = await resolveToken(shop, { token: legacyToken, clientId, clientSecret });
      await testConnection(shop, probe);
    } catch (e) {
      return json({ error: "Shopify rejected those credentials, so the daily email wasn't switched on. Reconnect your store and try again." }, 400);
    }

    const rec = {
      email,
      shop,
      // Only one of these is ever set. The client secret is as sensitive as
      // the old permanent token, so it gets the same encryption.
      token: legacyToken ? await encryptSecret(env, legacyToken) : null,
      clientId: clientId || null,
      clientSecret: clientSecret ? await encryptSecret(env, clientSecret) : null,
      hourUtc,
      localTime: String(body.localTime || "").slice(0, 5),
      profile: body.profile && typeof body.profile === "object" ? body.profile : null,
      createdAt: new Date().toISOString(),
      lastSent: null,
      lastError: null
    };
    await env.VYRLO_KV.put(key, JSON.stringify(rec));

    return json({ ok: true, subscription: publicView(rec) }, 200);
  } catch (e) {
    return json({ error: "Couldn't save that.", detail: String(e).slice(0, 200) }, 500);
  }
}
