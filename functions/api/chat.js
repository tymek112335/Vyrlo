// Cloudflare Pages Function - POST /api/chat
// Consultant chat. Multi-turn conversation with Claude, grounded in the
// owner's latest briefing + data. Gated behind ACCESS_CODE (cost control).

const CONSULTANT_SYSTEM = `You are Vyrlo's business consultant for the owner of a small e-commerce store. You talk like a sharp, blunt operator who has seen a lot of small stores: practical, numbers-first, no fluff, no corporate hedging.

Rules:
- Answer from the owner's data when it's provided. Ground claims in their actual numbers.
- If you don't have the data needed to answer, say so plainly and tell them exactly what to pull or paste.
- Never invent figures, causes, traffic, or ad data that isn't in what you were given.
- Keep replies short and useful. Lead with the answer. End with one or two concrete next steps only when they help.
- You are a consultant, not a cheerleader. Disagree when the owner is wrong.`;

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export async function onRequestPost(context) {
  const { env } = context;
  try {
    const body = await context.request.json().catch(() => ({}));

    if (!env.ACCESS_CODE || String(body.accessCode || "").trim() !== env.ACCESS_CODE) {
      return json({ error: "Enter your access code to use the consultant." }, 403);
    }
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Server is missing its API key." }, 500);

    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-20);
    if (!messages.length) return json({ error: "Say something first." }, 400);

    const brief = body.briefing ? JSON.stringify(body.briefing) : "";
    const raw = (body.rawText || "").slice(0, 6000);
    const system = CONSULTANT_SYSTEM
      + (brief ? `\n\nThe owner's latest briefing (JSON):\n${brief}` : "")
      + (raw ? `\n\nThe underlying numbers behind it:\n"""\n${raw}\n"""` : "")
      + (!brief && !raw ? `\n\nNo store data has been loaded yet. If the owner asks about their numbers, tell them to build a briefing or paste data first.` : "");

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system,
        messages: messages.map((m) => ({ role: m.role, content: m.content }))
      })
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return json({ error: "Consultant engine error.", detail: detail.slice(0, 300) }, 502);
    }
    const data = await resp.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    return json({ reply: textBlock ? textBlock.text : "No reply." }, 200);
  } catch (e) {
    return json({ error: "Chat failed.", detail: String(e).slice(0, 200) }, 500);
  }
}
