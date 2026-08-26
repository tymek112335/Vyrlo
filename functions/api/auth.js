// Cloudflare Pages Function - POST /api/auth
//
// signup | login | me | logout
//
// The session rides in an HttpOnly cookie rather than localStorage, so a
// script injected into the page can't read it. Everything the app needs to
// know about the account comes back in the response body instead.

import { normalizeEmail, hashPassword, verifyPassword, makeSession, readSession, getUser, putUser, userIsPro, readCookie } from "../_lib/auth.js";
import { checkFreeLimit, bumpStat } from "../_lib/access.js";

function json(obj, status, cookie) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(JSON.stringify(obj), { status, headers });
}

function sessionCookie(token, days) {
  const age = days > 0 ? days * 86400 : 0;
  return `vyrlo_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
}

function publicUser(user) {
  return { email: user.email, pro: userIsPro(user), expires: user.expires || null };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json().catch(() => ({}));
    const action = body.action;

    if (!env.VYRLO_KV || !env.SESSION_SECRET) {
      return json({ error: "Accounts aren't switched on yet." }, 503);
    }

    if (action === "me") {
      const email = await readSession(env, readCookie(request, "vyrlo_session"));
      const user = email ? await getUser(env, email) : null;
      return json({ ok: true, user: user ? publicUser(user) : null }, 200);
    }

    if (action === "logout") {
      return json({ ok: true }, 200, sessionCookie("", 0));
    }

    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    if (!email) return json({ error: "That doesn't look like a valid email address." }, 400);

    if (action === "signup") {
      if (password.length < 8) return json({ error: "Use at least 8 characters." }, 400);
      // Signup writes to KV, so it needs a ceiling of its own or it becomes a
      // way to fill the store from outside.
      if (!(await checkFreeLimit(env, request, "signup", 5))) {
        return json({ error: "Too many sign-ups from here today." }, 429);
      }
      if (await getUser(env, email)) {
        return json({ error: "There's already an account with that email. Try logging in." }, 409);
      }
      const { salt, hash } = await hashPassword(password);
      const user = await putUser(env, { email, salt, hash, created: new Date().toISOString(), expires: null });
      await bumpStat(env, "signups");
      return json({ ok: true, user: publicUser(user) }, 200, sessionCookie(await makeSession(env, email), 60));
    }

    if (action === "login") {
      const user = await getUser(env, email);
      // Same message and roughly the same work either way, so this can't be
      // used to find out which email addresses have accounts.
      const ok = user ? await verifyPassword(password, user.salt, user.hash) : false;
      if (!ok) return json({ error: "That email and password don't match." }, 401);
      return json({ ok: true, user: publicUser(user) }, 200, sessionCookie(await makeSession(env, email), 60));
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: "Something broke.", detail: String(e).slice(0, 200) }, 500);
  }
}
