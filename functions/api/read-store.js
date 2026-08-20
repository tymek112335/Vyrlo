// Cloudflare Pages Function - POST /api/read-store
// Reads a store's public pages and drafts the parts of the business profile
// that are actually visible from outside: what they sell, where they sell it,
// and observable facts like price spread.
//
// It deliberately does NOT guess goal, budget, hours, what they've tried, or
// what they think is wrong. None of that is knowable from a website, and
// inventing it would break the no-fabrication rule the whole product rests on.

import { checkFreeLimit } from "../_lib/access.js";

const READER_SYSTEM = `You read a small e-commerce store's public web pages and extract only what is genuinely visible there.

You are filling in the start of a business profile so the owner doesn't have to type it themselves. They will review and correct everything you write, so be accurate rather than impressive.

RULES — these matter more than being helpful:
- Only state what the page content actually shows. Never infer revenue, order volume, traffic, profitability, team size, or how well anything sells. A website cannot tell you those things.
- If the pages don't show something, leave that field as an empty string. An empty field is correct; a plausible guess is a failure.
- Write "sells" and "where" in the owner's own voice, first person is not needed — plain description, one sentence each, as if the owner wrote it quickly.
- For "findings", list concrete observable facts only: price points, number of products, what the homepage leads with, whether bundles exist and how they're priced against individual items, visible sales channels. Numbers where you can see them.
- Do not write marketing copy or compliments. No "beautifully designed" or "strong brand". Facts only.
- If the pages are mostly empty, blocked, or clearly not a store, say so in "problem" and leave the rest empty.`;

const READER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sells", "where", "findings", "problem"],
  properties: {
    sells: { type: "string", description: "One sentence: what this store sells. Empty string if unclear." },
    where: { type: "string", description: "Sales channels visible on the site (their own store, plus any linked marketplaces, retail, or markets). Empty string if only the site itself is evident." },
    findings: {
      type: "array",
      description: "Concrete observable facts. Empty array if the pages showed nothing useful.",
      items: { type: "string" }
    },
    problem: { type: "string", description: "Empty string normally. Only filled if the pages could not be read or are not a store." }
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// Only allow public http(s) hosts. Blocks localhost and private ranges so this
// endpoint can't be used to probe internal addresses.
function safeUrl(input) {
  // A scheme that isn't http(s) is rejected outright rather than having
  // "https://" pasted in front of it, which would silently turn
  // "file:///etc/passwd" into a request to a host called "file".
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^https?:\/\//i.test(input)) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(input) ? input : "https://" + input); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 192 && p[1] === 168) ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 169 && p[1] === 254)) return null;
  }
  if (h.includes(":")) return null; // bare IPv6, incl. ::1
  u.hash = "";
  return u;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function grab(url) {
  try {
    const resp = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; VyrloBot/1.0; +https://vyrlo.cc)", "accept": "text/html" },
      redirect: "follow",
      cf: { cacheTtl: 300 }
    });
    if (!resp.ok) return "";
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return "";
    const html = (await resp.text()).slice(0, 400000);
    return htmlToText(html).slice(0, 14000);
  } catch (e) {
    return "";
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Server is missing its API key." }, 500);

    if (!(await checkFreeLimit(env, request, "readstore", 5))) {
      return json({ error: "Too many store reads today — try again tomorrow." }, 429);
    }

    const body = await request.json().catch(() => ({}));
    const url = safeUrl(String(body.url || "").trim());
    if (!url) return json({ error: "That doesn't look like a store address. Try something like yourstore.com" }, 400);

    // Homepage plus a couple of the usual Shopify paths. Best effort — a miss
    // on any of these is fine, the homepage alone is usually enough.
    const origin = url.origin;
    const paths = [url.toString(), origin + "/pages/about", origin + "/collections/all"];
    const pages = await Promise.all(paths.map(grab));
    const text = pages.filter(Boolean).join("\n\n---\n\n").slice(0, 26000);

    if (!text || text.length < 120) {
      return json({ error: "Couldn't read that site — it may block bots or be temporarily down. Fill the questions in yourself and you'll get the same result." }, 502);
    }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        // Extraction task, not analysis — a small fast model is the right tool
        // and keeps this cheap enough to leave open to free users.
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        system: READER_SYSTEM,
        output_config: { format: { type: "json_schema", schema: READER_SCHEMA } },
        messages: [{
          role: "user",
          content: `Public page text from ${url.hostname}:\n"""\n${text}\n"""\n\nExtract the profile fields as JSON, following the rules exactly.`
        }]
      })
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return json({ error: "Couldn't read that store.", detail: detail.slice(0, 300) }, 502);
    }

    const data = await resp.json();
    if (data.stop_reason === "max_tokens") {
      return json({ error: "That store had too much on the page to read in one pass." }, 502);
    }
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) return json({ error: "Empty response reading that store." }, 502);

    const out = JSON.parse(textBlock.text);
    if (out.problem) return json({ error: out.problem }, 422);

    return json({
      ok: true,
      site: url.hostname,
      drafted: { sells: out.sells || "", where: out.where || "" },
      findings: Array.isArray(out.findings) ? out.findings.slice(0, 8) : []
    }, 200);
  } catch (e) {
    return json({ error: "Couldn't read that store.", detail: String(e).slice(0, 200) }, 500);
  }
}
