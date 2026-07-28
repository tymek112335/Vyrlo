// Cloudflare Pages Function — POST /api/generate
// Turns pasted raw data into a structured report via Claude.
// Requires the ANTHROPIC_API_KEY environment variable (set it in the
// Cloudflare Pages project → Settings → Environment variables).

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "metrics", "trend", "channels", "highlights", "recommendations"],
  properties: {
    summary: { type: "string" },
    metrics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value", "delta", "positive"],
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          delta: { type: "string" },     // e.g. "+27%", "-18%", "+0.4x"
          positive: { type: "boolean" }  // is this change GOOD for the client?
        }
      }
    },
    trend: {
      type: "object",
      additionalProperties: false,
      required: ["label", "points"],
      properties: {
        label: { type: "string" },
        points: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "value"],
            properties: {
              label: { type: "string" },  // e.g. "Oct", "Nov"
              value: { type: "number" }
            }
          }
        }
      }
    },
    channels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "value", "share"],
        properties: {
          name: { type: "string" },
          value: { type: "string" },   // e.g. "228 leads"
          share: { type: "number" }    // 0-100
        }
      }
    },
    highlights: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } }
  }
};

const SYSTEM = `You are a senior marketing-agency analyst writing a monthly client report.
You receive whatever the agency pastes — analytics numbers, ad-platform exports, or a plain-language description. Turn it into a polished, ROI-led report.

Rules:
- Executive summary: 2-4 sentences, lead with the business outcome (revenue, pipeline, or ROI), and use <b>...</b> around the 1-2 most important figures. No fluff.
- Metrics: pick the 4-6 most important. Keep values as short display strings with units ("$14.20", "4.8%", "3.2x"). "delta" is the change vs. prior period with a sign. "positive" = whether that change is GOOD for the client (a FALLING cost-per-lead is positive:true).
- Trend: choose the single most important metric to chart over time. If the data has a time series, use it. If not, build a plausible 6-point monthly trajectory consistent with the stated result, ending on the current value.
- Channels: break results down by source/channel if the data implies any; estimate shares (summing to ~100). Omit with an empty array only if truly impossible.
- Highlights: 2-3 concrete things that worked, tied to the numbers.
- Recommendations: 2-3 specific, actionable next steps.
- Ground everything in the numbers provided; do not invent wildly different figures. Professional, confident, not corporate-stiff.`;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json().catch(() => ({}));
    const rawText = (body.rawText || "").trim();
    const client = body.client || "Client";
    const period = body.period || "";
    const agency = body.agency || "Your agency";
    const accent = body.accent || "#5A4BE8";

    if (!rawText) return json({ error: "Paste some data first." }, 400);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Server is missing its API key." }, 500);

    const userMsg =
      `Client: ${client}\nPeriod: ${period || "this month"}\n\n` +
      `Raw results the agency pasted:\n"""\n${rawText}\n"""\n\n` +
      `Write the report as JSON matching the required schema.`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-opus-5", // swap to "claude-haiku-4-5" to cut cost ~5x
        max_tokens: 4000,
        system: SYSTEM,
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: REPORT_SCHEMA }
        },
        messages: [{ role: "user", content: userMsg }]
      })
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return json({ error: "Report engine error.", detail }, 502);
    }

    const data = await resp.json();
    if (data.stop_reason === "refusal") {
      return json({ error: "Couldn't process that input — try rephrasing the data." }, 422);
    }

    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) return json({ error: "Empty response from report engine." }, 502);

    const ai = JSON.parse(textBlock.text);
    // Merge in the header fields the user typed (kept verbatim).
    return json({ agency, client, period, accent, ...ai }, 200);
  } catch (e) {
    return json({ error: "Something broke generating the report.", detail: String(e) }, 500);
  }
}
