// Shared briefing → email helpers. Used by /api/send-briefing ("send me a
// copy of what I'm looking at") and /api/cron (the automatic morning send).
//
// The text is always rebuilt server-side from the briefing object rather than
// taken from the client, so neither endpoint can be turned into an open mail
// relay for arbitrary content.

function esc(s) { return String(s == null ? "" : s); }

export function briefingToText(b, opts) {
  const o = opts || {};
  const s = b.summary || {}, w = b.why || {}, r = b.risk || {}, op = b.opportunity || {};
  const L = [];
  L.push(esc(s.headline)); L.push(""); L.push(esc(s.body)); L.push("");
  L.push("Business health: " + esc(s.health)); L.push("");
  L.push("WHAT CHANGED");
  (Array.isArray(b.what_changed) ? b.what_changed : []).slice(0, 8).forEach((m) => {
    L.push("- " + esc(m.metric) + " " + esc(m.value) + ": " + esc(m.explanation));
  });
  L.push(""); L.push("WHY IT HAPPENED"); L.push(esc(w.question));
  (Array.isArray(w.reasons) ? w.reasons : []).slice(0, 6).forEach((x, i) => L.push((i + 1) + ". " + esc(x)));
  L.push("Confidence: " + esc(w.confidence)); L.push("");
  L.push("RISK"); L.push(esc(r.title) + " " + esc(r.detail));
  if (r.action) L.push("Action: " + esc(r.action));
  L.push(""); L.push("OPPORTUNITY"); L.push(esc(op.title) + " " + esc(op.detail));
  if (op.recommendation) L.push("Recommendation: " + esc(op.recommendation));
  L.push(""); L.push("RECOMMENDATIONS");
  (Array.isArray(b.recommendations) ? b.recommendations : []).slice(0, 6).forEach((x, i) => {
    L.push((i + 1) + ". " + esc(x.title) + " (" + esc(x.effort) + "): " + esc(x.reason));
  });
  if (Array.isArray(o.alerts) && o.alerts.length) {
    L.push(""); L.push("WATCHLIST");
    o.alerts.slice(0, 8).forEach((a) => L.push("- " + esc(a)));
  }
  L.push("");
  L.push("Generated with Vyrlo, vyrlo.cc");
  if (o.unsubscribe) L.push("Stop these daily emails: turn off Daily Email in vyrlo.cc/app");
  return L.join("\n");
}

export async function sendMail(env, to, subject, text) {
  if (!env.RESEND_API_KEY) throw new Error("Email isn't set up yet.");
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "authorization": "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.RESEND_FROM || "Vyrlo <briefing@vyrlo.cc>",
      to: [to],
      subject: String(subject || "Your briefing").slice(0, 200),
      text
    })
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error("Resend " + resp.status + ": " + detail.slice(0, 300));
  }
  return true;
}
