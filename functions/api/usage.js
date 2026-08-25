// Cloudflare Pages Function - POST /api/usage
//
// What a paid code has used this month, for the meter in the sidebar and the
// usage page behind it. Free users are metered entirely in the browser — one
// briefing a week needs no server round trip to display.

import { isValidCode, getUsage, codeInfo, PRO_MONTHLY } from "../_lib/access.js";

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export async function onRequestPost(context) {
  const { env } = context;
  try {
    const body = await context.request.json().catch(() => ({}));
    const code = String(body.accessCode || "").trim();
    if (!(await isValidCode(env, code))) return json({ error: "No access code." }, 403);

    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const [thisMonth, lastMonth, info] = await Promise.all([
      getUsage(env, code),
      getUsage(env, code, prev),
      codeInfo(env, code)
    ]);

    return json({
      ok: true,
      limit: PRO_MONTHLY,
      used: thisMonth.total,
      remaining: Math.max(0, PRO_MONTHLY - thisMonth.total),
      days: thisMonth.days,               // { "2026-08-25": 3, ... }
      lastMonthTotal: lastMonth.total,
      month: now.toISOString().slice(0, 7),
      expires: (info && info.expires) || null
    }, 200);
  } catch (e) {
    return json({ error: "Couldn't read usage.", detail: String(e).slice(0, 200) }, 500);
  }
}
