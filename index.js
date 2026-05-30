/**
 * Coles Price Scraper — Main Entry Point
 * Runs an Express server (keeps Render.com alive) + daily cron job
 *
 * Environment variables required (set in Render dashboard):
 *   SUPABASE_URL       — your Supabase project URL
 *   SUPABASE_KEY       — your Supabase service_role key (not anon)
 *   SCRAPE_SECRET      — a secret string to protect the /scrape endpoint
 *   PORT               — set automatically by Render
 */

const express = require("express");
const cron = require("node-cron");
const { runScraper } = require("./scraper");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Health check (keeps Render free tier alive) ───────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Coles Price Tracker", time: new Date().toISOString() });
});

// ── Manual trigger endpoint (protected) ──────────────────────────────────
app.post("/scrape", async (req, res) => {
  const secret = req.headers["x-scrape-secret"];
  if (secret !== process.env.SCRAPE_SECRET) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  try {
    const results = await runScraper();
    res.json({ ok: true, scraped: results.length, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Price history API — called by the Chrome extension ───────────────────
app.get("/prices/:productId", async (req, res) => {
  // Allow CORS from coles.com.au
  res.setHeader("Access-Control-Allow-Origin", "https://www.coles.com.au");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );

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

// ── All tracked products list ─────────────────────────────────────────────
app.get("/products", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "https://www.coles.com.au");
  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );
    const { data, error } = await supabase
      .from("tracked_products")
      .select("product_id, name, url, last_price, last_checked")
      .order("name");
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Add a product to track ────────────────────────────────────────────────
app.post("/products", async (req, res) => {
  const secret = req.headers["x-scrape-secret"];
  if (secret !== process.env.SCRAPE_SECRET) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  const { product_id, name, url } = req.body;
  if (!product_id || !url) {
    return res.status(400).json({ error: "product_id and url are required" });
  }
  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );
    const { data, error } = await supabase
      .from("tracked_products")
      .upsert({ product_id, name, url }, { onConflict: "product_id" })
      .select();
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Daily cron: runs at 8:00 AM AEST (UTC+10 = 22:00 UTC prev day) ───────
cron.schedule("0 22 * * *", async () => {
  console.log("[CRON] Starting daily price scrape...");
  try {
    const results = await runScraper();
    console.log(`[CRON] Done. Scraped ${results.length} products.`);
  } catch (err) {
    console.error("[CRON] Scrape failed:", err.message);
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Coles Price Tracker running on port ${PORT}`);
  console.log(`[Server] Daily scrape scheduled at 8:00 AM AEST`);
});
