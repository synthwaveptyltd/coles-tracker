/**
 * Coles Price Scraper — API Version
 * Updates prices for all tracked products using Coles JSON API
 */

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-AU,en;q=0.9",
  "Origin": "https://www.coles.com.au",
  "Referer": "https://www.coles.com.au/",
};

// Fetch price for a single product via API
async function fetchProductPrice(productId) {
  const url = `https://www.coles.com.au/api/2.0.0/product/${productId}`;
  try {
    const res = await fetch(url, { headers: HEADERS, timeout: 10000 });
    if (!res.ok) return null;
    const data = await res.json();
    const price = data?.pricing?.now ||
                  data?.price?.now ||
                  data?.nowPrice ||
                  data?.price;
    return price ? parseFloat(price) : null;
  } catch {
    return null;
  }
}

async function scrapeAllProducts() {
  const supabase = getSupabase();
  const today = new Date().toISOString().split("T")[0];

  const { data: products, error } = await supabase
    .from("products")
    .select("id, name")
    .not("id", "is", null);

  if (error) throw error;
  if (!products?.length) {
    console.log("[Scraper] No products. Run catalog crawl first.");
    return [];
  }

  console.log(`[Scraper] Updating prices for ${products.length} products...`);
  let success = 0, failed = 0;

  // Process in batches of 10
  for (let i = 0; i < products.length; i += 10) {
    const batch = products.slice(i, i + 10);
    await Promise.all(batch.map(async (product) => {
      const price = await fetchProductPrice(product.id);
      if (price != null) {
        await supabase.from("products")
          .update({ current_price: price, last_updated: new Date().toISOString() })
          .eq("id", product.id);
        await supabase.from("price_history")
          .upsert({ product_id: product.id, price, recorded_at: today },
            { onConflict: "product_id,recorded_at" });
        success++;
      } else {
        failed++;
      }
    }));

    if (i % 100 === 0) console.log(`[Scraper] Progress: ${i}/${products.length}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`[Scraper] Done! ✓ ${success} updated, ✗ ${failed} failed`);
  return { success, failed };
}

module.exports = { scrapeAllProducts };
