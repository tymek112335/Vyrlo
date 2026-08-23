// Symmetric encryption for the one genuinely sensitive thing Vyrlo stores:
// a customer's Shopify Admin API token, which the daily-email job needs to
// keep so it can pull fresh numbers while nobody is at the keyboard.
//
// Everything else in Vyrlo lives in the browser's localStorage precisely so
// there is nothing worth stealing server-side. The daily email breaks that
// rule by necessity, so the token is encrypted at rest with AES-GCM under
// TOKEN_SECRET (a Cloudflare secret, not in KV) rather than sitting in KV in
// plain text. If TOKEN_SECRET is missing, callers refuse to store anything
// rather than silently downgrading to plaintext.

const enc = new TextEncoder();
const dec = new TextDecoder();

async function keyFrom(secret) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function encryptSecret(env, plain) {
  if (!env.TOKEN_SECRET) throw new Error("TOKEN_SECRET is not set");
  const key = await keyFrom(env.TOKEN_SECRET);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(String(plain))));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return toB64(packed);
}

export async function decryptSecret(env, packedB64) {
  if (!env.TOKEN_SECRET) throw new Error("TOKEN_SECRET is not set");
  const key = await keyFrom(env.TOKEN_SECRET);
  const packed = fromB64(String(packedB64));
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return dec.decode(plain);
}
