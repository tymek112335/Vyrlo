// Cloudflare Pages Function - POST /api/shopify/claim
//
// Hands the freshly minted store token to the browser that just finished the
// install, exactly once. The id is random, lives five minutes, and is deleted
// on first read, so a claim left behind in history is worthless.

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.VYRLO_KV) return json({ error: "Not configured." }, 503);
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "").trim();
    if (!/^[0-9a-f]{32}$/.test(id)) return json({ error: "That connection link isn't valid." }, 400);

    const key = "claim:" + id;
    const raw = await env.VYRLO_KV.get(key);
    if (!raw) return json({ error: "That connection has already been used, or it expired. Connect again from Shopify Connect." }, 404);
    await env.VYRLO_KV.delete(key);

    return json(JSON.parse(raw), 200);
  } catch (e) {
    return json({ error: "Couldn't finish connecting.", detail: String(e).slice(0, 200) }, 500);
  }
}
