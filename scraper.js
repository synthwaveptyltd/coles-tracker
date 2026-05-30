/**
 * Coles Price Scraper — Core Logic
 * Uses Playwright to scrape product pages and saves to Supabase
 */

const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
  );
}

// ── Extract price from a Coles product page ───────────────────────────────
async function scrapePricePage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for price element
  await page.waitForSelector(
    '[data-testid="product-pricing"], [class*="price__value"], [class*="price-"]',
    { timeout: 15000 }
  ).catch(() => {});

  const result = await page.evaluate(() => {
    const selectors = [
      '[data-testid="product-pricing"] [class*="price__value"]',
      '[class*="price__value"]',
      '[class*="ProductPrice"] [class*="value"]',
      '[class*="price-"] span',
      '.price',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const raw = el.textContent.replace(/[^0-9.]/g, "");
        const price = parseFloat(raw);
        if (!isNaN(price) && price > 0) return price;
      }
    }
    return null;
  });

  const name = await page.evaluate(() => {
    const el = document.querySelector('h1') || document.querySelector('[data-testid="product-title"]');
    return el ? el.textContent.trim() : document.title.split("|")[0].trim();
  });

  return { price: result, name };
}

// ── Record a single price entry ───────────────────────────────────────────
async function recordPrice(supabase, productId, price, name) {
  const today = new Date().toISOString().split("T")[0];

  // Upsert into price_history (one row per product per day)
  const { error: histErr } = await supabase
    .from("price_history")
    .upsert(
      { product_id: productId, recorded_at: today, price },
      { onConflict: "product_id,recorded_at" }
    );
  if (histErr) throw histErr;

  // Update tracked_products last_price
  const { error: prodErr } = await supabase
    .from("tracked_products")
    .update({ last_price: price, last_checked: new Date().toISOString(), name })
    .eq("product_id", productId);
  if (prodErr) throw prodErr;
}

// ── Main scraper: iterates all tracked products ───────────────────────────
async function runScraper() {
  const supabase = getSupabase();

  // Load all tracked products
  const { data: products, error } = await supabase
    .from("tracked_products")
    .select("product_id, name, url");
  if (error) throw error;
  if (!products.length) {
    console.log("[Scraper] No products to scrape.");
    return [];
  }

  console.log(`[Scraper] Scraping ${products.length} products...`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const results = [];

  for (const product of products) {
    try {
      const page = await browser.newPage();
      await page.setExtraHTTPHeaders({
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      });

      const { price, name } = await scrapePricePage(page, product.url);
      await page.close();

      if (price) {
        await recordPrice(supabase, product.product_id, price, name);
        console.log(`[Scraper] ✓ ${name}: $${price}`);
        results.push({ product_id: product.product_id, name, price, ok: true });
      } else {
        console.warn(`[Scraper] ✗ Could not extract price for ${product.url}`);
        results.push({ product_id: product.product_id, ok: false, error: "No price found" });
      }

      // Polite delay between requests
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));
    } catch (err) {
      console.error(`[Scraper] Error on ${product.url}:`, err.message);
      results.push({ product_id: product.product_id, ok: false, error: err.message });
    }
  }

  await browser.close();
  return results;
}

module.exports = { runScraper };
