/**
 * Coles Price Tracker v4 — API-based, no browser needed
 */

const express = require("express");
const cron = require("node-cron");
const { crawlCatalog } = require("./catalog");
const { scrapeAllProducts } = require("./scraper");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Coles Price Tracker v4", time: new Date().toISOString() });
});

app.get("/prices/:productId", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data, error } = await supabase
      .from("price_history").select("recorded_at, price")
      .eq("product_id", req.params.productId)
      .order("recorded_at", { ascending: true }).limit(120);
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/products", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data, error } = await supabase.from("products")
      .select("id, name, category, current_price, last_updated")
      .order("name").limit(500);
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Browser-friendly triggers ─────────────────────────────
app.get("/trigger", (req, res) => {
  if (req.query.secret !== process.env.SCRAPE_SECRET)
    return res.send("Wrong secret.");
  res.send("Catalog crawl started! Check /status in 10 minutes.");
  crawlCatalog().catch(console.error);
});

app.get("/trigger-scrape", (req, res) => {
  if (req.query.secret !== process.env.SCRAPE_SECRET)
    return res.send("Wrong secret.");
  res.send("Price scrape started! Check /status in 10 minutes.");
  scrapeAllProducts().catch(console.error);
});

// ── Register product from extension ──────────────────────
app.post("/products", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-scrape-secret");
  const { product_id, name, url } = req.body;
  if (!product_id || !url) return res.status(400).json({ error: "product_id and url required" });
  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { error } = await supabase.from("products")
      .upsert({ id: product_id, name, url, category: "manual" }, { onConflict: "id" });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.options("/products", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-scrape-secret");
  res.sendStatus(200);
});

// ── Cron: 6 AM AEST = crawl, 8 AM AEST = scrape ─────────
cron.schedule("0 20 * * *", () => {
  console.log("[CRON] Catalog crawl starting...");
  crawlCatalog().catch(console.error);
});
cron.schedule("0 22 * * *", () => {
  console.log("[CRON] Price scrape starting...");
  scrapeAllProducts().catch(console.error);
});

app.listen(PORT, () => {
  console.log(`[Server] Coles Price Tracker v4 running on port ${PORT}`);
});
