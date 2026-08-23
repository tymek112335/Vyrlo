// Shared Shopify pull. Used by /api/shopify (owner clicks "Pull from
// Shopify") and by /api/cron (the nightly daily-email job), so both produce
// exactly the same numbers summary — the shape a user would otherwise paste
// in by hand.

const API_VERSION = "2024-10";

// Only real Shopify admin hosts. The shop domain arrives from the customer,
// so without this check /api/shopify would happily fetch any host they name
// with their own token attached — an SSRF hole and a credential leak.
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export function normalizeShop(input) {
  const shop = String(input || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  return SHOP_RE.test(shop) ? shop : null;
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

// Cheap credential check: one tiny call that fails loudly on a bad token or
// missing scope, so "Test connection" can say which of the two went wrong
// instead of dumping a raw 401 on the owner.
export async function testConnection(shop, token) {
  const s = await shopFetch(shop, token, "shop.json");
  return { name: (s.shop && s.shop.name) || shop, tz: (s.shop && s.shop.iana_timezone) || "UTC" };
}

export async function pullStoreNumbers(shop, token) {
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

  return { raw, shop, period: yDay ? `Yesterday (${yDay})` : "Recent", day: yDay || null };
}
