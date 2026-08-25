// Cloudflare Pages Function - POST /api/hit
//
// A page counter for the owner's dashboard, so there's some idea whether
// anyone is arriving without adding a third-party analytics script. Records
// nothing about the visitor — no cookie, no identifier, no stored IP.
//
// It counts unique visitors per day rather than raw hits, and that is a
// security property as much as a reporting one: the endpoint is necessarily
// unauthenticated, KV on the free plan allows about a thousand writes a day,
// and a naive counter would let anyone exhaust that with a loop — taking the
// free-tier limiter, usage counting and the daily-email records down with
// it. A once-per-IP-per-day marker means repeat requests cost a read and no
// write at all.

import { bumpStat } from "../_lib/access.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.VYRLO_KV) return new Response(null, { status: 204 });

    const body = await request.json().catch(() => ({}));
    const page = body.page === "app" ? "views_app" : "views_site";
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const day = new Date().toISOString().slice(0, 10);
    const marker = `seen:${page}:${day}:${ip}`;

    if (await env.VYRLO_KV.get(marker)) return new Response(null, { status: 204 });
    await env.VYRLO_KV.put(marker, "1", { expirationTtl: 90000 });
    await bumpStat(env, page);
  } catch (e) {
    // A counter is never worth failing a page load over.
  }
  return new Response(null, { status: 204 });
}
