/**
 * Coles Price Scraper
 * Fetches current prices for ALL products registered in Supabase
 * Runs daily after the catalog crawl has registered products
 */

const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

async function extractPrice(page) {
  return await page.evaluate(() => {
    const selectors = [
      '[data-testid="product-pricing"] [class*="price__value"]',
      '[class*="price__value"]',
      '[class*="ProductPrice"] [class*="value"]',
      '[class*="price-"] span',
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
}

async function scrapeAllProducts() {
  const supabase = getSupabase();

  // Load all products from Supabase
  const { data: products, error } = await supabase
    .from("products")
    .select("id, name, url")
    .not("url", "is", null);

  if (error) throw error;
  if (!products?.length) {
    console.log("[Scraper] No products found. Run catalog crawl first.");
    return [];
  }

  console.log(`[Scraper] Scraping prices for ${products.length} products...`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const today = new Date().toISOString().split("T")[0];
  const results = [];
  let successCount = 0;
  let failCount = 0;

  // Process in batches of 5 (parallel pages)
  const BATCH_SIZE = 5;
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (product) => {
      const page = await browser.newPage();
      try {
        await page.setExtraHTTPHeaders({
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        });

        await page.goto(product.url, { waitUntil: "domcontentloaded", timeout: 25000 });
        await page.waitForTimeout(1500);

        const price = await extractPrice(page);

        if (price != null) {
          // Update current price in products table
          await supabase.from("products").update({
            current_price: price,
            last_updated: new Date().toISOString(),
          }).eq("id", product.id);

          // Insert into price_history
          await supabase.from("price_history").upsert(
            { product_id: product.id, price, recorded_at: today },
            { onConflict: "product_id,recorded_at" }
          );

          successCount++;
          results.push({ id: product.id, price, ok: true });
          if (successCount % 50 === 0) {
            console.log(`[Scraper] Progress: ${successCount} prices recorded...`);
          }
        } else {
          failCount++;
          results.push({ id: product.id, ok: false, error: "No price found" });
        }
      } catch (err) {
        failCount++;
        results.push({ id: product.id, ok: false, error: err.message });
      } finally {
        await page.close();
      }
    }));

    // Pause between batches
    await new Promise((r) => setTimeout(r, 2000));
  }

  await browser.close();
  console.log(`[Scraper] Complete! ✓ ${successCount} prices recorded, ✗ ${failCount} failed`);
  return results;
}

module.exports = { scrapeAllProducts };
