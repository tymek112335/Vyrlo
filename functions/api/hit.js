// Cloudflare Pages Function - POST /api/hit
//
// A one-line page counter, so the owner can see whether anyone is arriving
// without adding a third-party analytics script. Records nothing about the
// visitor — no cookie, no identifier, no IP kept. Just a number per day.

import { bumpStat } from "../_lib/access.js";

export async function onRequestPost(context) {
  const { env } = context;
  try {
    const body = await context.request.json().catch(() => ({}));
    const page = body.page === "app" ? "views_app" : "views_site";
    await bumpStat(env, page);
  } catch (e) {
    // A counter is never worth failing a page load over.
  }
  return new Response(null, { status: 204 });
}
