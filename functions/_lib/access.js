// Shared helpers for the Vyrlo Pages Functions: access-code validation and
// the owner's business profile block.

// The profile is answered once in the app and sent with every request. It is
// what lets the model advise inside the owner's real constraints (budget,
// hours, what they already tried) instead of giving generic advice.
const PROFILE_LABELS = {
  sells: "What they sell",
  where: "Where they sell",
  size: "Rough size of the business",
  goal: "What they want to be true in 90 days",
  budget: "Monthly budget for growth",
  hours: "Hours a week available",
  tried: "Already tried, didn't work",
  problem: "What the owner thinks the problem is"
};

export function profileBlock(profile) {
  if (!profile || typeof profile !== "object") return "";
  const lines = Object.keys(PROFILE_LABELS)
    .map((k) => {
      const v = String(profile[k] == null ? "" : profile[k]).trim();
      return v ? `- ${PROFILE_LABELS[k]}: ${v.slice(0, 600)}` : "";
    })
    .filter(Boolean);
  if (!lines.length) return "";

  return `

THE OWNER'S BUSINESS (they told you this themselves — it is context, not data to analyse):
${lines.join("\n")}

How to use it:
- Every recommendation must fit their stated budget and hours. Do not suggest paid ads to someone with no budget, or a 20-hour project to someone with five hours a week.
- Do not re-recommend something listed under "already tried" unless you explain specifically what would be different this time.
- Judge progress against the goal they gave you, not a generic benchmark.
- If the numbers contradict what they think their problem is, say so directly and show which figure disagrees. That contradiction is one of the most useful things you can tell them.
- Never treat this section as sales figures. It is background, not evidence. It cannot support a claim about what actually happened in their data.`;
}

// Server-side backstop for the free tier. The UI's free-briefing limit is a
// client-side localStorage flag (no accounts/DB, by design), so it's only a
// nicety — anyone can clear it or call the API directly. This is the real
// ceiling: a per-IP cap in KV, skipped entirely for a valid access code. If
// VYRLO_KV isn't bound, this fails open (no limit) rather than blocking every
// unpaid request — same tradeoff isValidCode already makes.
//
// period is "day" or "week". Briefings are weekly on the free plan; the
// cheaper endpoints (chat, outbound mail) stay daily. The cap sits a little
// above the advertised limit on purpose: several people behind one office or
// mobile IP shouldn't lock each other out of a plan they were promised.
function periodStamp(period) {
  const now = new Date();
  if (period !== "week") return now.toISOString().slice(0, 10);
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // Monday-based
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return "w" + d.toISOString().slice(0, 10);
}

export async function checkFreeLimit(env, request, bucket, limit, period) {
  if (!env.VYRLO_KV) return true;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const stamp = periodStamp(period);
  const key = `freelimit:${bucket}:${ip}:${stamp}`;
  const current = parseInt((await env.VYRLO_KV.get(key)) || "0", 10);
  if (current >= limit) return false;
  // Just past the window it counts, so a stale counter can't outlive it.
  await env.VYRLO_KV.put(key, String(current + 1), { expirationTtl: period === "week" ? 700000 : 90000 });
  return true;
}

// What a paid code is actually worth in a month. "Unlimited" meant no server
// check at all, so one code could have run up an unbounded model bill.
export const PRO_MONTHLY = 300;

function monthKey(d) { return (d || new Date()).toISOString().slice(0, 7); }
function dayKey(d) { return (d || new Date()).toISOString().slice(0, 10); }

// One record per code per month: a total plus a per-day breakdown, which is
// what the usage page needs anyway. Read-modify-write can lose a count under
// exactly simultaneous requests; at one owner generating a briefing at a time
// that is not worth a locking scheme.
export async function getUsage(env, code, when) {
  if (!env.VYRLO_KV) return { total: 0, days: {} };
  const raw = await env.VYRLO_KV.get(`usage:${code}:${monthKey(when)}`);
  if (!raw) return { total: 0, days: {} };
  try {
    const rec = JSON.parse(raw);
    return { total: rec.total || 0, days: rec.days || {} };
  } catch (e) { return { total: 0, days: {} }; }
}

export async function bumpUsage(env, code) {
  if (!env.VYRLO_KV) return;
  const key = `usage:${code}:${monthKey()}`;
  const rec = await getUsage(env, code);
  rec.total = (rec.total || 0) + 1;
  const d = dayKey();
  rec.days[d] = (rec.days[d] || 0) + 1;
  // Kept ~13 months so the usage page can show the previous month too.
  await env.VYRLO_KV.put(key, JSON.stringify(rec), { expirationTtl: 34000000 });
}

/* ---------- owner-facing records ----------
   Codes expire, and their KV entry goes with them. That's right for access
   and wrong for knowing who ever bought: a month later the customer would
   have vanished from the list entirely. Customers are therefore kept in a
   second, permanent record that outlives the code it points at. */
export async function saveCustomer(env, label, code, expires) {
  if (!env.VYRLO_KV) return null;
  const id = String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "customer";
  const key = "cust:" + id;
  let rec = null;
  try { rec = JSON.parse(await env.VYRLO_KV.get(key)); } catch (e) {}
  if (!rec) rec = { id, label, created: new Date().toISOString(), issues: [] };
  rec.label = label;
  rec.code = code;
  rec.expires = expires;
  rec.issues.push({ code, issued: new Date().toISOString(), expires });
  rec.issues = rec.issues.slice(-24);
  await env.VYRLO_KV.put(key, JSON.stringify(rec));
  return rec;
}

export async function listCustomers(env) {
  if (!env.VYRLO_KV) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.VYRLO_KV.list({ prefix: "cust:", cursor });
    cursor = page.list_complete ? null : page.cursor;
    for (const k of page.keys) {
      try { out.push(JSON.parse(await env.VYRLO_KV.get(k.name))); } catch (e) {}
    }
  } while (cursor && out.length < 300);
  return out;
}

/* ---------- counters ----------
   One record per day holding every number worth watching. Cheap to write,
   and it means the owner's dashboard is reading a handful of keys rather
   than scanning the whole namespace. */
export async function bumpStat(env, field, n) {
  if (!env.VYRLO_KV) return;
  const key = "stats:" + new Date().toISOString().slice(0, 10);
  let rec = {};
  try { rec = JSON.parse(await env.VYRLO_KV.get(key)) || {}; } catch (e) {}
  rec[field] = (rec[field] || 0) + (n || 1);
  await env.VYRLO_KV.put(key, JSON.stringify(rec), { expirationTtl: 34000000 });
}

export async function getStats(env, days) {
  if (!env.VYRLO_KV) return [];
  const out = [];
  for (let i = (days || 30) - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    let rec = {};
    try { rec = JSON.parse(await env.VYRLO_KV.get("stats:" + d)) || {}; } catch (e) {}
    out.push({ date: d, ...rec });
  }
  return out;
}

export async function isValidCode(env, code) {
  code = String(code || "").trim();
  if (!code) return false;
  if (env.ACCESS_CODE && code === env.ACCESS_CODE) return true;
  if (!env.VYRLO_KV) return false;
  return !!(await env.VYRLO_KV.get("code:" + code));
}

// Manually issued access, for invoiced customers. Stripe's webhook mints
// codes that live forever because Stripe tells us when they lapse; an
// invoiced code has nobody to report a cancellation, so it carries its own
// expiry as a KV TTL and lets itself out.
export async function issueManualCode(env, label, days) {
  const d = Math.min(400, Math.max(1, parseInt(days, 10) || 31));
  const code = crypto.randomUUID().split("-")[0].toUpperCase();
  const expires = new Date(Date.now() + d * 864e5).toISOString();
  const rec = { label: String(label || "").slice(0, 120), issued: new Date().toISOString(), expires, manual: true };
  await env.VYRLO_KV.put("code:" + code, JSON.stringify(rec), { expirationTtl: d * 86400 });
  return { code, ...rec };
}

// What a code is worth, for the app to show "expires in N days" rather than
// letting someone find out by being silently downgraded mid-week.
export async function codeInfo(env, code) {
  code = String(code || "").trim();
  if (!code) return null;
  if (env.ACCESS_CODE && code === env.ACCESS_CODE) return { owner: true };
  if (!env.VYRLO_KV) return null;
  const raw = await env.VYRLO_KV.get("code:" + code);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return { legacy: true }; }
}

export async function issueCode(env, customerId) {
  const existing = await env.VYRLO_KV.get("customer:" + customerId);
  if (existing) return existing;
  const code = crypto.randomUUID().split("-")[0].toUpperCase();
  await env.VYRLO_KV.put("code:" + code, customerId);
  await env.VYRLO_KV.put("customer:" + customerId, code);
  return code;
}

export async function revokeByCustomer(env, customerId) {
  const code = await env.VYRLO_KV.get("customer:" + customerId);
  if (!code) return;
  await env.VYRLO_KV.delete("code:" + code);
  await env.VYRLO_KV.delete("customer:" + customerId);
}
