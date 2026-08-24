// Shopify OAuth (authorization code grant).
//
// The client-credentials grant this connect flow first used only works on
// development stores — a paid store hands back a token its own API then
// rejects with "Invalid API key or access token". Every real customer is on a
// paid plan, so the merchant-install flow is the only one that can work.
//
// Needs two Cloudflare secrets, Vyrlo's own app credentials (not the
// merchant's): SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.

export const SCOPES = "read_orders,read_products";

// Shopify signs its callback with the app's client secret. Verifying it is
// what stops anyone from calling /callback with a shop and code of their
// choosing and having Vyrlo store a connection for a store they don't own.
export async function verifyHmac(url, clientSecret) {
  const params = new URL(url).searchParams;
  const sent = params.get("hmac");
  if (!sent) return false;

  // Every parameter except hmac, sorted, joined — Shopify's documented rule.
  const pairs = [];
  for (const [k, v] of params) {
    if (k === "hmac") continue;
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const message = pairs.map(([k, v]) => `${k}=${v}`).join("&");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(clientSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  let hex = "";
  for (const b of sig) hex += b.toString(16).padStart(2, "0");

  // Length-safe compare without an early exit on the first wrong byte.
  if (hex.length !== sent.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sent.charCodeAt(i);
  return diff === 0;
}

export function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

// Swaps the one-time code Shopify sent back for a permanent offline token.
export async function exchangeCode(shop, clientId, clientSecret, code) {
  const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code })
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error("Shopify code exchange " + resp.status + ": " + detail.slice(0, 300));
  }
  const data = await resp.json();
  if (!data.access_token) throw new Error("Shopify returned no access token.");
  return data.access_token;
}
