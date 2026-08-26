// Cloudflare Pages Function - GET /api/auth/google/callback
//
// Step two: Google sends the visitor back with a code. Exchange it, read the
// email out of the id_token, and either log that account in or make one.
//
// The id_token's signature isn't checked here on purpose: it arrives in the
// body of a direct server-to-server HTTPS response from Google's token
// endpoint, authenticated by the client secret, which is exactly the case
// Google documents as not needing verification. A token pulled from a
// redirect or a client would need the full JWKS check.

import { makeSession, getUser, putUser, normalizeEmail } from "../../../_lib/auth.js";
import { bumpStat } from "../../../_lib/access.js";

function page(title, body, status) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Vyrlo</title>` +
    `<body style="font:16px/1.6 system-ui;padding:40px;max-width:34rem;margin:auto">` +
    `<h1 style="font-size:20px">${title}</h1>${body}<p><a href="/app">Back to Vyrlo</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function decodeJwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  const s = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { return null; }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.VYRLO_KV || !env.SESSION_SECRET) {
      return page("Not configured", "<p>Google sign-in isn't set up on this server yet.</p>", 500);
    }
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (url.searchParams.get("error")) return page("Sign-in cancelled", "<p>Nothing was changed.</p>", 400);
    if (!code || !state) return page("Something's missing", "<p>Google didn't send everything needed. Try again from Vyrlo.</p>", 400);

    // Proves this redirect belongs to a flow this server started.
    const stateKey = "gstate:" + state;
    const known = await env.VYRLO_KV.get(stateKey);
    await env.VYRLO_KV.delete(stateKey);
    if (!known) return page("That link has expired", "<p>Start signing in again from Vyrlo.</p>", 400);

    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: url.origin + "/api/auth/google/callback",
        grant_type: "authorization_code"
      })
    });
    if (!resp.ok) {
      return page("Google wouldn't finish sign-in", `<p>${(await resp.text()).slice(0, 200)}</p>`, 502);
    }
    const data = await resp.json();
    const claims = decodeJwtPayload(data.id_token);
    const email = normalizeEmail(claims && claims.email);
    if (!email) return page("No email from Google", "<p>That account didn't share an email address, so there's nothing to attach a plan to.</p>", 400);
    if (claims.email_verified === false) {
      return page("Email not verified", "<p>Google hasn't verified that address, so it can't be used to sign in.</p>", 400);
    }

    let user = await getUser(env, email);
    if (!user) {
      // No password: this account signs in with Google. Setting one later is
      // the ordinary reset flow, which proves the same address either way.
      user = await putUser(env, { email, salt: null, hash: null, google: true, created: new Date().toISOString(), expires: null });
      await bumpStat(env, "signups");
    } else if (!user.google) {
      // Same person, second way in. Google has verified this address, so
      // linking it doesn't let anyone reach an account they couldn't already.
      user.google = true;
      await putUser(env, user);
    }

    const token = await makeSession(env, email);
    return new Response(null, {
      status: 302,
      headers: {
        location: "/app",
        "set-cookie": `vyrlo_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 86400}`
      }
    });
  } catch (e) {
    return page("Sign-in failed", `<p>${String(e && e.message || e).slice(0, 200)}</p>`, 500);
  }
}
