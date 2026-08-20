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

// Server-side backstop for the free tier. The UI's "1 free briefing" is a
// client-side localStorage flag (no accounts/DB, by design), so it's only a
// nicety — anyone can clear it or call the API directly. This is the real
// ceiling: a per-IP daily cap in KV, skipped entirely for a valid access
// code. If VYRLO_KV isn't bound yet, this fails open (no limit) rather than
// blocking every unpaid request — same tradeoff isValidCode already makes.
export async function checkFreeLimit(env, request, bucket, limit) {
  if (!env.VYRLO_KV) return true;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const key = `freelimit:${bucket}:${ip}:${day}`;
  const current = parseInt((await env.VYRLO_KV.get(key)) || "0", 10);
  if (current >= limit) return false;
  await env.VYRLO_KV.put(key, String(current + 1), { expirationTtl: 90000 });
  return true;
}

export async function isValidCode(env, code) {
  code = String(code || "").trim();
  if (!code) return false;
  if (env.ACCESS_CODE && code === env.ACCESS_CODE) return true;
  if (!env.VYRLO_KV) return false;
  return !!(await env.VYRLO_KV.get("code:" + code));
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
