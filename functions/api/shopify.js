// Cloudflare Pages Function - POST /api/shopify
// Private, single-store connect: pulls the owner's Shopify orders, aggregates
// them into a numbers summary, and runs that through the briefing engine
// (/api/generate). Gated behind ACCESS_CODE so only the owner can trigger it.
//
// Requires Cloudflare env vars:
//   SHOPIFY_SHOP   e.g. yourstore.myshopify.com
//   SHOPIFY_TOKEN  Admin API access token (custom app)
//   ACCESS_CODE    the owner's unlock code
//   ANTHROPIC_API_KEY (used by /api/generate)

const API_VERSION = "2024-10";

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

async function shopFetch(shop, token, path) {
  const resp = await fetch(`https://${shop}/admin/api/${API_VERSION}/${path}`, {
    headers: { "X-Shopify-Access-Token": token, "content-type": "application/json" }
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error("Shopify " + resp.status + ": " + detail.slice(0, 300));
  }
  return resp.json();
}

function money(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString("en-US"); }

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json().catch(() => ({}));

    // Only the owner (or code-holders) can pull the store's data.
    if (!env.ACCESS_CODE || String(body.accessCode || "").trim() !== env.ACCESS_CODE) {
      return json({ error: "This is locked. Enter your access code first." }, 403);
    }
    if (!env.SHOPIFY_SHOP || !env.SHOPIFY_TOKEN) {
      return json({ error: "Shopify isn't connected yet. Add SHOPIFY_SHOP and SHOPIFY_TOKEN in Cloudflare." }, 400);
    }

    const shop = env.SHOPIFY_SHOP.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const token = env.SHOPIFY_TOKEN;

    // Store timezone, for correct local day boundaries.
    let tz = "UTC";
    try { const s = await shopFetch(shop, token, "shop.json"); tz = (s.shop && s.shop.iana_timezone) || "UTC"; } catch (e) {}

    const localDate = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
    const todayLocal = new Date().toLocaleDateString("en-CA", { timeZone: tz });

    // Pull orders from the last ~10 days.
    const since = new Date(Date.now() - 10 * 864e5).toISOString();
    const ord = await shopFetch(shop, token, `orders.json?status=any&created_at_min=${encodeURIComponent(since)}&limit=250`);
    const orders = ord.orders || [];

    // Group by local date.
    const byDay = {};
    for (const o of orders) {
      const d = localDate(o.created_at);
      (byDay[d] = byDay[d] || []).push(o);
    }
    // Two most recent completed days (before today) that have orders.
    const days = Object.keys(byDay).filter((d) => d < todayLocal).sort().reverse();
    const yDay = days[0], pDay = days[1];

    function summarize(dayOrders) {
      let revenue = 0, refunds = 0, refundAmt = 0, newC = 0, retC = 0;
      const products = {};
      for (const o of (dayOrders || [])) {
        revenue += parseFloat(o.total_price || 0);
        const rAmt = (o.refunds || []).reduce((s, r) => s + (r.transactions || []).reduce((t, x) => t + parseFloat(x.amount || 0), 0), 0);
        if ((o.refunds || []).length || /refunded/.test(o.financial_status || "")) { refunds++; refundAmt += rAmt; }
        const oc = o.customer && o.customer.orders_count ? o.customer.orders_count : 1;
        if (oc > 1) retC++; else newC++;
        for (const li of (o.line_items || [])) products[li.title] = (products[li.title] || 0) + (li.quantity || 0);
      }
      const n = (dayOrders || []).length;
      return { n, revenue, aov: n ? revenue / n : 0, refunds, refundAmt, newC, retC, products };
    }

    const Y = summarize(byDay[yDay]);
    const P = summarize(byDay[pDay]);

    // Inventory for context (top stock levels).
    let stockLines = [];
    try {
      const pr = await shopFetch(shop, token, "products.json?limit=100&fields=title,variants");
      for (const p of (pr.products || [])) {
        const q = (p.variants || []).reduce((s, v) => s + (v.inventory_quantity || 0), 0);
        stockLines.push({ title: p.title, q });
      }
      stockLines.sort((a, b) => a.q - b.q);
      stockLines = stockLines.slice(0, 8);
    } catch (e) {}

    // Build the numbers summary (the same shape a user would paste).
    let raw = `Shopify store: ${shop}\n`;
    if (!yDay) {
      raw += `No completed sales days with orders in the last 10 days. The store is very quiet right now.\n`;
    } else {
      raw += `Yesterday (${yDay})${pDay ? ` vs prior day (${pDay})` : ""}:\n\n`;
      raw += `Revenue: ${money(Y.revenue)}${pDay ? ` (prev ${money(P.revenue)})` : ""}\n`;
      raw += `Orders: ${Y.n}${pDay ? ` (prev ${P.n})` : ""}\n`;
      raw += `Average order value: ${money(Y.aov)}${pDay ? ` (prev ${money(P.aov)})` : ""}\n`;
      raw += `New customers: ${Y.newC}, returning: ${Y.retC}\n`;
      raw += `Refunds: ${Y.refunds}${Y.refundAmt ? ` (${money(Y.refundAmt)})` : ""}${pDay ? ` (prev ${P.refunds})` : ""}\n`;
      const prodLines = Object.keys(Y.products).sort((a, b) => Y.products[b] - Y.products[a]).slice(0, 10);
      if (prodLines.length) {
        raw += `\nUnits sold by product (yesterday):\n`;
        for (const t of prodLines) raw += `- ${t}: ${Y.products[t]}${P.products[t] != null ? ` (prev ${P.products[t]})` : ""}\n`;
      }
    }
    if (stockLines.length) {
      raw += `\nStock on hand (lowest first):\n`;
      for (const s of stockLines) raw += `- ${s.title}: ${s.q}\n`;
    }

    // Run it through the briefing engine.
    const origin = new URL(request.url).origin;
    const gen = await fetch(`${origin}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawText: raw, period: yDay ? `Yesterday (${yDay})` : "Recent" })
    });
    if (!gen.ok) {
      const d = await gen.text();
      return json({ error: "Briefing engine error on Shopify data.", detail: d.slice(0, 300) }, 502);
    }
    const briefing = await gen.json();
    if (briefing.error) return json({ error: briefing.error }, 502);

    return json({ briefing, rawText: raw, shop }, 200);
  } catch (e) {
    return json({ error: "Shopify pull failed.", detail: String(e).slice(0, 300) }, 500);
  }
}
