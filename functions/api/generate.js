import { isValidCode, profileBlock } from "../_lib/access.js";

// Cloudflare Pages Function — POST /api/generate
// Two modes on one endpoint:
//   default → turns pasted/uploaded business data into a daily briefing
//   {mode:"ask"} → answers a question about the current briefing, grounded in it
// Requires the ANTHROPIC_API_KEY environment variable (Cloudflare → Settings →
// Variables and Secrets → Production).

const BRIEFING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "what_changed", "why", "risk", "opportunity", "recommendations", "narrative"],
  properties: {
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["headline", "body", "health", "reading_time"],
      properties: {
        headline: { type: "string" },              // one short line, e.g. "Yesterday was a strong day."
        body: { type: "string" },                   // one plain-language paragraph
        health: { type: "string", enum: ["good", "watch", "at_risk"] },
        reading_time: { type: "string" }            // e.g. "1 minute"
      }
    },
    what_changed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["metric", "direction", "value", "positive", "explanation", "detail"],
        properties: {
          metric: { type: "string" },              // "Revenue", "Profit margin", "AOV"
          direction: { type: "string", enum: ["up", "down", "flat"] },
          value: { type: "string" },               // short display delta: "+14%", "-3%", "$68"
          positive: { type: "boolean" },           // is this change GOOD for the business?
          explanation: { type: "string" },         // one line
          detail: { type: "string" }               // 2-3 sentences shown when the card is expanded
        }
      }
    },
    why: {
      type: "object",
      additionalProperties: false,
      required: ["question", "reasons", "confidence", "reasoning"],
      properties: {
        question: { type: "string" },              // "Why did revenue increase?"
        reasons: { type: "array", items: { type: "string" } }, // 2-3, each grounded in the data
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        reasoning: { type: "string" }              // how the conclusion was reached AND what the data can't show
      }
    },
    risk: {
      type: "object",
      additionalProperties: false,
      required: ["title", "detail", "action"],
      properties: {
        title: { type: "string" },
        detail: { type: "string" },
        action: { type: "string" }                 // suggested next step (or "" if none warranted)
      }
    },
    opportunity: {
      type: "object",
      additionalProperties: false,
      required: ["title", "detail", "recommendation", "impact"],
      properties: {
        title: { type: "string" },
        detail: { type: "string" },
        recommendation: { type: "string" },
        impact: { type: "string" }                 // plain-language potential impact
      }
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "reason", "effort"],
        properties: {
          title: { type: "string" },               // a concrete action
          reason: { type: "string" },              // why, tied to a number
          effort: { type: "string" }               // "5 min", "15 min", etc.
        }
      }
    },
    narrative: {
      type: "array",
      items: { type: "string" }                    // 3-4 longer paragraphs, the full-depth read
    }
  }
};

const BRIEFING_SYSTEM = `You are a business analyst writing a short daily briefing for the owner of a small e-commerce business. You receive a dump of their business data — a CSV export, pasted numbers, or a plain-language description. Turn it into a briefing they can read in two minutes: what changed, why, one risk, one opportunity, and the few actions worth taking.

TRUTHFULNESS — this is the whole product; a single made-up claim destroys trust:
- State only what the data actually supports. NEVER invent a cause you cannot see in the data.
- If a metric changed and the data has breakdowns (by product, customer type, order value, channel), explain the change through those breakdowns. If the data is just totals with no breakdown, say the change happened but that the data doesn't reveal why — and set why.confidence to "low".
- Do NOT reference website traffic, ad campaigns, email sends, discounts, or seasonality unless those figures are actually present in the data. If they aren't in the data, you cannot claim them as causes.
- why.confidence: "high" = the explanation is clearly decomposable from the numbers provided; "medium" = a reasonable inference; "low" = the data is too thin to really explain it.
- why.reasoning: briefly say what you compared to reach the conclusion, AND state plainly what the data does NOT let you see (e.g. "This export has no traffic or ad data, so the reason for the visit drop can't be confirmed here.").
- The risk and opportunity must be grounded in the uploaded data. An inventory-runout risk needs stock levels; a cross-sell opportunity needs order/line-item detail. If the data can't support a genuine risk or opportunity, say so plainly in the title/detail rather than inventing one.
- Ground every figure in what was provided. Do not fabricate numbers.

IF THE DATA IS A SCREENSHOT OR IMAGE (e.g. a photo of an analytics dashboard):
- Read only the figures you can actually see. If a number is cut off, blurred, or ambiguous, do not guess it — leave it out and say in why.reasoning that part of the image wasn't legible.
- A dashboard screenshot usually shows totals without the underlying breakdown. That means you normally CANNOT explain why a metric moved: set why.confidence to "low" and say plainly that the screenshot shows totals only.
- Do not assume a date range, comparison period, or currency that isn't visible in the image.

STYLE:
- summary.headline: one short, human line ("Yesterday was a strong day.", "A quieter day, with one thing to watch.").
- summary.body: ONE plain paragraph, no jargon, lead with the business outcome. This is the two-minute read — keep it short, the depth belongs in narrative.
- summary.health: "good" when mostly positive with no pressing problem; "watch" when mixed; "at_risk" when there's a real problem.
- what_changed: the 4-6 most important metrics. value is a short display delta with units. positive = whether that change is good for the business (a FALLING cost is positive:true). Where you can, express the delta as a percentage ("+14%") rather than only a raw total — percentages let metrics with different units be compared visually, and at least one or two metrics with a genuine percentage change make that possible.
- recommendations: 2-3 concrete, specific next steps with a realistic effort estimate. No vague advice.
- narrative: 3-4 longer paragraphs for the owner who wants the full depth, not just the two-minute version. Do not just restate summary.body. Cover: how the metrics in what_changed relate to each other (e.g. did the AOV rise because of the same thing that drove revenue, or a different cause), a fuller version of the reasoning behind why (more than the one-line reasons array), how the risk and opportunity connect to the numbers, and — as its own short final paragraph — what remains genuinely uncertain from this data (echo why.reasoning's caveat, expanded). Every figure used here must already appear elsewhere in the briefing; narrative explains connections between existing figures, it does not compute or introduce new ones.
- Calm, direct, non-technical throughout.`;

const COMPARE_SYSTEM = `You are the analyst behind a business owner's daily briefings. They are looking at two briefings side by side and want to know what actually changed between them.

Write 4 short paragraphs, plain language, no headings, no bullet points, no markdown:
1. The headline movement between the two, in one or two sentences.
2. The metrics that moved most, with the actual before and after figures from the briefings.
3. Whether the risk and opportunity are the same as before or have shifted, and what that means.
4. The one or two things worth doing now because of what changed.

TRUTHFULNESS — a single invented figure destroys the product:
- Use only figures that appear in the two briefings given to you. Never compute a number you cannot derive from them, and never invent one.
- The two briefings may cover different periods and may not be directly comparable. If the metric labels or units don't line up, say so plainly instead of forcing a comparison.
- These briefings summarise data you cannot see. Do not claim a cause (ads, traffic, seasonality, promotions) that isn't already stated in one of them.
- If the two briefings are too different to compare usefully, say that in the first paragraph and keep the rest short.
- Refer to the two briefings by the labels given, not as "briefing A" and "briefing B".`;

const ASK_SYSTEM = `You are the analyst behind a business owner's daily briefing. Answer their follow-up question using ONLY the briefing and the underlying data provided. Be direct and plain-language, 1-3 short sentences. If the data doesn't contain what's needed to answer, say so honestly rather than guessing — do not invent numbers or causes.`;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Returns a {media_type, data} pair only if it's a supported image within the
// size limit; anything else returns null so the caller can reject it cleanly.
function validImage(img) {
  if (!img || typeof img !== "object") return null;
  const media_type = String(img.media_type || "").toLowerCase();
  const data = String(img.data || "");
  if (!IMAGE_TYPES.includes(media_type)) return null;
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return null;
  if (data.length * 0.75 > MAX_IMAGE_BYTES) return null;
  return { media_type, data };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function callClaude(env, { system, userMsg, schema, maxTokens }) {
  const body = {
    model: "claude-opus-5",
    max_tokens: maxTokens || 4000,
    system,
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: userMsg }]
  };
  if (schema) body.output_config.format = { type: "json_schema", schema };

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const detail = await resp.text();
    return { error: json({ error: "Analysis engine error.", detail }, 502) };
  }
  const data = await resp.json();
  if (data.stop_reason === "refusal") {
    return { error: json({ error: "Couldn't process that input — try rephrasing the data." }, 422) };
  }
  if (data.stop_reason === "max_tokens") {
    // The response was cut off mid-generation, which for schema mode means
    // invalid JSON. Say so plainly instead of letting JSON.parse throw an
    // opaque syntax error further down.
    return { error: json({ error: "The briefing was too long to finish in one pass — try trimming the data a little and generating again." }, 502) };
  }
  // Skip thinking blocks; take the text block.
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) return { error: json({ error: "Empty response from the engine." }, 502) };
  return { text: textBlock.text };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const reqBody = await request.json().catch(() => ({}));

    // ---- Access-code verify (no model call, no key needed) -----------------
    // A correct code unlocks unlimited use in the UI. The free-try limit is
    // enforced client-side (browser flag) and bounded by the Anthropic spend cap.
    if (reqBody.mode === "verify") {
      const ok = await isValidCode(env, reqBody.accessCode);
      return json({ ok }, 200);
    }

    if (!env.ANTHROPIC_API_KEY) return json({ error: "Server is missing its API key." }, 500);

    // ---- Ask AI mode -------------------------------------------------------
    if (reqBody.mode === "ask") {
      const question = (reqBody.question || "").trim();
      const briefing = reqBody.briefing || {};
      const rawText = (reqBody.rawText || "").trim();
      if (!question) return json({ error: "Ask a question first." }, 400);

      const userMsg =
        `Today's briefing (JSON):\n"""\n${JSON.stringify(briefing)}\n"""\n\n` +
        (rawText ? `The underlying data the briefing was built from:\n"""\n${rawText}\n"""\n\n` : "") +
        `The owner asks: ${question}\n\nAnswer using only the above.`;

      const out = await callClaude(env, { system: ASK_SYSTEM + profileBlock(reqBody.profile), userMsg });
      if (out.error) return out.error;
      return json({ answer: out.text.trim() }, 200);
    }

    // ---- Compare mode ------------------------------------------------------
    if (reqBody.mode === "compare") {
      const newer = reqBody.newer, older = reqBody.older;
      if (!newer || !older) return json({ error: "Pick two briefings to compare." }, 400);
      const newerLabel = String(reqBody.newerLabel || "the later briefing").slice(0, 80);
      const olderLabel = String(reqBody.olderLabel || "the earlier briefing").slice(0, 80);

      const userMsg =
        `Earlier briefing — "${olderLabel}" (JSON):\n"""\n${JSON.stringify(older)}\n"""\n\n` +
        `Later briefing — "${newerLabel}" (JSON):\n"""\n${JSON.stringify(newer)}\n"""\n\n` +
        `Compare them for the owner, following the rules exactly.`;

      const out = await callClaude(env, { system: COMPARE_SYSTEM + profileBlock(reqBody.profile), userMsg });
      if (out.error) return out.error;
      return json({ answer: out.text.trim() }, 200);
    }

    // ---- Briefing mode -----------------------------------------------------
    const rawText = (reqBody.rawText || "").trim();
    const period = reqBody.period || "";
    const image = validImage(reqBody.image);
    // Check the image first: an unreadable image is a specific, fixable problem,
    // and saying "add some data first" when they clearly added something is wrong.
    if (reqBody.image && !image) return json({ error: "That image couldn't be read — use a PNG, JPEG, GIF or WebP under 4MB." }, 400);
    if (!rawText && !image) return json({ error: "Add some data first." }, 400);

    const prompt =
      (period ? `Period: ${period}\n\n` : "") +
      (image ? `The owner uploaded a screenshot of their business data.\n\n` : "") +
      (rawText ? `The owner's business data:\n"""\n${rawText}\n"""\n\n` : "") +
      `Write today's briefing as JSON matching the required schema. Follow the truthfulness rules exactly.`;

    // An image needs content blocks; plain text can stay a bare string.
    const userMsg = image
      ? [{ type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
         { type: "text", text: prompt }]
      : prompt;

    // Higher ceiling than the other two modes: the full schema plus the
    // narrative field can run well past 4000 tokens on a busier input (more
    // line items, more what_changed entries) — a real case truncated mid-JSON
    // at ~4000 during testing. Cost scales with tokens actually generated, not
    // this cap, and the schema itself bounds the shape either way.
    const out = await callClaude(env, { system: BRIEFING_SYSTEM + profileBlock(reqBody.profile), userMsg, schema: BRIEFING_SCHEMA, maxTokens: 8000 });
    if (out.error) return out.error;

    const briefing = JSON.parse(out.text);
    return json(briefing, 200);
  } catch (e) {
    return json({ error: "Something broke generating the briefing.", detail: String(e) }, 500);
  }
}
