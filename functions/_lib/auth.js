// Accounts for Vyrlo.
//
// Deliberately narrow: an account carries who you are and what you're
// entitled to, and nothing else. Briefings stay in the browser, which is what
// lets the site keep saying your data isn't stored on a server — the moment
// that stops being true it needs a privacy policy, an export path and a
// delete path, none of which exist.
//
// Stored per user in KV as user:<email>:
//   { email, hash, salt, created, plan, expires }
//
// Workers has no bcrypt, so passwords are PBKDF2-SHA256 over WebCrypto with a
// per-user salt. Sessions are a signed token rather than a stored row: there
// is nothing to look up, nothing to clean up, and revoking is a matter of
// rotating SESSION_SECRET.

const enc = new TextEncoder();

const PBKDF2_ITERATIONS = 150000;
const SESSION_DAYS = 60;

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64(str) {
  const s = atob(String(str).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 160 ? e : null;
}

async function derive(password, saltBytes) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), hash: b64(await derive(password, salt)) };
}

export async function verifyPassword(password, saltB64, hashB64) {
  const derived = b64(await derive(password, unb64(saltB64)));
  // Compare the encodings, not the bytes, and without an early exit.
  if (derived.length !== String(hashB64).length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i++) diff |= derived.charCodeAt(i) ^ String(hashB64).charCodeAt(i);
  return diff === 0;
}

async function signingKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function makeSession(env, email) {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  const payload = b64(enc.encode(JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 864e5 })));
  const sig = b64(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env.SESSION_SECRET), enc.encode(payload))));
  return payload + "." + sig;
}

export async function readSession(env, token) {
  try {
    if (!env.SESSION_SECRET) return null;
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig) return null;
    const expect = b64(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env.SESSION_SECRET), enc.encode(payload))));
    if (expect.length !== sig.length) return null;
    let diff = 0;
    for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff !== 0) return null;
    const data = JSON.parse(new TextDecoder().decode(unb64(payload)));
    if (!data.x || data.x < Date.now()) return null;
    return data.e || null;
  } catch (e) { return null; }
}

export async function getUser(env, email) {
  if (!env.VYRLO_KV || !email) return null;
  try { return JSON.parse(await env.VYRLO_KV.get("user:" + email)); } catch (e) { return null; }
}

export async function putUser(env, user) {
  await env.VYRLO_KV.put("user:" + user.email, JSON.stringify(user));
  return user;
}

// An account is Pro while its expiry is in the future. Same shape as a code,
// so everything downstream can treat the two the same way.
export function userIsPro(user) {
  return !!(user && user.expires && new Date(user.expires).getTime() > Date.now());
}

// The session half of "is this person entitled". Endpoints combine it with
// their own access-code check rather than this file importing access.js,
// which would make the two modules import each other.
export function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function proFromSession(env, request) {
  const email = await readSession(env, readCookie(request, "vyrlo_session"));
  if (!email) return null;
  const user = await getUser(env, email);
  if (!user) return null;
  return { email, pro: userIsPro(user), expires: user.expires || null };
}
