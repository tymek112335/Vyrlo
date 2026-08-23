// Cloudflare Pages Function - /api/cron
//
// The automatic morning briefing. Cloudflare Pages has no scheduled handler
// (cron triggers are a Workers feature), so this is an ordinary endpoint
// driven from outside by a GitHub Actions schedule — see
// .github/workflows/daily-briefing.yml. Free, and the schedule lives next to
// the code instead of in a dashboard.
//
// It is called once an hour and only sends to subscribers whose chosen hour
// matches the current UTC hour and who haven't already been sent to today.
// That makes it safe to call more often than needed, and safe to retry.
//
// Auth: the x-cron-secret header must equal CRON_SECRET.

import { decryptSecret } from "../_lib/crypto.js";
import { pullStoreNumbers, resolveToken } from "../_lib/shopify.js";
import { briefingToText, sendMail } from "../_lib/email.js";

// One invocation's worth of work. Well above any plausible subscriber count
// right now; the cursor loop below picks up the rest on the next hourly run
// rather than risking a timeout mid-batch.
const MAX_PER_RUN = 25;

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// Timing-safe-ish comparison. Not a true constant-time primitive, but it
// removes the trivial early-exit-on-first-byte signal.
function secretMatches(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function runOne(env, origin, code, rec) {
  // Post-2026 apps store a client secret and mint a fresh 24h token on every
  // run; pre-2026 ones store the permanent token itself. Either way nothing
  // long-lived is held in memory beyond this call.
  const creds = rec.clientSecret
    ? { clientId: rec.clientId, clientSecret: await decryptSecret(env, rec.clientSecret) }
    : { token: await decryptSecret(env, rec.token) };
  const token = await resolveToken(rec.shop, creds);
  if (!token) throw new Error("No usable Shopify credentials on this subscription.");
  const pulled = await pullStoreNumbers(rec.shop, token);

  const gen = await fetch(`${origin}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rawText: pulled.raw,
      period: pulled.period,
      profile: rec.profile || undefined,
      accessCode: code
    })
  });
  if (!gen.ok) throw new Error("generate " + gen.status + ": " + (await gen.text()).slice(0, 200));
  const briefing = await gen.json();
  if (briefing.error) throw new Error(String(briefing.error).slice(0, 200));

  const headline = String((briefing.summary && briefing.summary.headline) || "Your morning briefing").slice(0, 200);
  await sendMail(env, rec.email, headline, briefingToText(briefing, { unsubscribe: true }).slice(0, 12000));
  return headline;
}

async function handle(context) {
  const { request, env } = context;

  if (!secretMatches(request.headers.get("x-cron-secret"), env.CRON_SECRET)) {
    return json({ error: "Not authorised." }, 403);
  }
  if (!env.VYRLO_KV) return json({ error: "No KV bound." }, 503);
  if (!env.TOKEN_SECRET) return json({ error: "No TOKEN_SECRET set." }, 503);

  const now = new Date();
  const hourUtc = now.getUTCHours();
  const today = now.toISOString().slice(0, 10);
  const origin = new URL(request.url).origin;
  // ?force=1 ignores the hour match, for testing a real send by hand.
  const force = new URL(request.url).searchParams.get("force") === "1";

  const result = { hourUtc, checked: 0, sent: 0, skipped: 0, failed: 0, errors: [] };
  let cursor;

  do {
    const page = await env.VYRLO_KV.list({ prefix: "daily:", cursor });
    cursor = page.list_complete ? null : page.cursor;

    for (const k of page.keys) {
      if (result.sent + result.failed >= MAX_PER_RUN) { cursor = null; break; }
      result.checked++;

      const raw = await env.VYRLO_KV.get(k.name);
      if (!raw) { result.skipped++; continue; }

      let rec;
      try { rec = JSON.parse(raw); } catch (e) { result.skipped++; continue; }

      if (!force && rec.hourUtc !== hourUtc) { result.skipped++; continue; }
      if (rec.lastSent === today) { result.skipped++; continue; }

      const code = k.name.slice("daily:".length);
      try {
        await runOne(env, origin, code, rec);
        rec.lastSent = today;
        rec.lastError = null;
        result.sent++;
      } catch (e) {
        // Record the failure on the subscription so the owner can see why
        // their email didn't arrive, but don't set lastSent — the next
        // hourly run will try again rather than silently skipping the day.
        rec.lastError = String(e).slice(0, 200);
        result.failed++;
        result.errors.push({ shop: rec.shop, error: rec.lastError });
      }
      await env.VYRLO_KV.put(k.name, JSON.stringify(rec));
    }
  } while (cursor);

  return json(result, 200);
}

export const onRequestPost = handle;
export const onRequestGet = handle;
