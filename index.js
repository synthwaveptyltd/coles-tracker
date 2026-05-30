/**
 * Coles Price Tracker v3 — Auto Catalog Crawler
 * Automatically discovers ALL products across Coles categories
 * and tracks prices daily — no manual registration needed.
 */

const express = require("express");
const cron = require("node-cron");
const { crawlCatalog } = require("./catalog");
const { scrapeAllProducts } = require("./scraper");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ── Health check ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Coles Price Tracker v3",
    time: new Date().toISOString(),
  });
});

// ── Price history API (called by Chrome extension) ────────
app.get("/prices/:productId", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data, error } = await supabase
      .from("price_history")
      .select("recorded_at, price")
      .eq("product_id", req.params.productId)
      .order("recorded_at", { ascending: true })
      .limit(120);
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── All products list ─────────────────────────────────────
app.get("/products", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data, error } = await supabase
      .from("products")
      .select("id, name, category, current_price, last_updated")
      .order("name")
      .limit(500);
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Scrape status ─────────────────────────────────────────
app.get("/status", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { count: productCount } = await supabase
      .from("products").select("*", { count: "exact", head: true });
    const { count: historyCount } = await supabase
      .from("price_history").select("*", { count: "exact", head: true });
    res.json({ ok: true, products_tracked: productCount, price_records: historyCount });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Manual triggers (protected) ───────────────────────────
function checkSecret(req, res) {
  if (req.headers["x-scrape-secret"] !== process.env.SCRAPE_SECRET) {
    res.status(401).json({ error: "Unauthorised" });
    return false;
  }
  return true;
}

app.post("/crawl", async (req, res) => {
  if (!checkSecret(req, res)) return;
  res.json({ ok: true, message: "Catalog crawl started in background" });
  crawlCatalog().catch(console.error);
});

app.post("/scrape", async (req, res) => {
  if (!checkSecret(req, res)) return;
  res.json({ ok: true, message: "Price scrape started in background" });
  scrapeAllProducts().catch(console.error);
});

// ── Also register individual products from extension ──────
app.post("/products", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { product_id, name, url } = req.body;
  if (!product_id || !url) return res.status(400).json({ error: "product_id and url required" });
  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { error } = await supabase.from("products")
      .upsert({ id: product_id, name, url, category: "manual" }, { onConflict: "id" });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── CRON SCHEDULE ─────────────────────────────────────────
// 6:00 AM AEST (20:00 UTC) — crawl catalog for new products
cron.schedule("0 20 * * *", async () => {
  console.log("[CRON] Starting catalog crawl...");
  try { await crawlCatalog(); }
  catch (err) { console.error("[CRON] Crawl failed:", err.message); }
});

// 8:00 AM AEST (22:00 UTC) — scrape prices for all products
cron.schedule("0 22 * * *", async () => {
  console.log("[CRON] Starting daily price scrape...");
  try { await scrapeAllProducts(); }
  catch (err) { console.error("[CRON] Scrape failed:", err.message); }
});

app.listen(PORT, () => {
  console.log(`[Server] Coles Price Tracker v3 running on port ${PORT}`);
  console.log(`[Server] Catalog crawl: 6 AM AEST daily`);
  console.log(`[Server] Price scrape:  8 AM AEST daily`);
});

