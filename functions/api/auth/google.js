// Cloudflare Pages Function - GET /api/auth/google
//
// Step one of Sign in with Google. Only openid/email/profile are asked for —
// all non-sensitive, which is what keeps this out of Google's verification
// process entirely. Vyrlo wants an identity, not access to anyone's Gmail.

function fail(message) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Vyrlo</title>` +
    `<body style="font:16px/1.6 system-ui;padding:40px;max-width:34rem;margin:auto">` +
    `<h1 style="font-size:20px">Couldn't start Google sign-in</h1><p>${message}</p>` +
    `<p><a href="/app">Back to Vyrlo</a></p></body>`,
    { status: 400, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return fail("Google sign-in isn't configured on this server yet.");
  if (!env.VYRLO_KV || !env.SESSION_SECRET) return fail("Accounts aren't switched on yet.");

  const url = new URL(request.url);
  const state = crypto.randomUUID().replace(/-/g, "");
  await env.VYRLO_KV.put("gstate:" + state, "1", { expirationTtl: 600 });

  const authorize = "https://accounts.google.com/o/oauth2/v2/auth"
    + "?client_id=" + encodeURIComponent(env.GOOGLE_CLIENT_ID)
    + "&redirect_uri=" + encodeURIComponent(url.origin + "/api/auth/google/callback")
    + "&response_type=code"
    + "&scope=" + encodeURIComponent("openid email profile")
    + "&state=" + encodeURIComponent(state)
    // Skips the account chooser only when there's exactly one session, which
    // is the whole point of offering this over a password.
    + "&prompt=select_account";

  return Response.redirect(authorize, 302);
}
