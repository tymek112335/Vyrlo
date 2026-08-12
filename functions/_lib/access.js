// Shared access-code validation for the free master code (env.ACCESS_CODE)
// and Stripe-issued per-customer codes stored in the VYRLO_KV namespace.

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
