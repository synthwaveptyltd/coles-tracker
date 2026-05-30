/**
 * Coles Catalog Crawler — API Version
 * Uses Coles's own JSON API directly — no browser, no Playwright.
 * Fast, lightweight, works on free hosting tier.
 */

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

// Coles API headers — mimics a real browser request
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-AU,en;q=0.9",
  "Origin": "https://www.coles.com.au",
  "Referer": "https://www.coles.com.au/",
};

// All Coles categories with their API slugs
const CATEGORIES = [
  "fruit-vegetables",
  "meat-seafood-deli",
  "dairy-eggs-fridge",
  "bakery",
  "pantry",
  "snacks-confectionery",
  "drinks",
  "frozen",
  "health-wellness",
  "baby",
  "household",
  "pet",
  "personal-care",
];

// Fetch one page of products from Coles API
async function fetchCategoryPage(category, page = 1) {
  const url = `https://www.coles.com.au/api/2.0.0/page/categories/${category}?pageSize=48&page=${page}`;
  try {
    const res = await fetch(url, { headers: HEADERS, timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json;
  } catch (err) {
    console.error(`[API] Failed to fetch ${category} page ${page}:`, err.message);
    return null;
  }
}

// Extract products from API response
function extractProducts(data, category) {
  const products = [];
  const catalogEntries = data?.pageProps?.searchResults?.results || 
                         data?.results || 
                         data?.catalogEntries || 
                         [];

  for (const item of catalogEntries) {
    try {
      const id = item.id || item.stockcode || item._id;
      const name = item.name || item.description || item.brand;
      const price = item.pricing?.now || 
                    item.price?.now || 
                    item.nowPrice || 
                    item.price;
      const imageUrl = item.imageUris?.[0]?.uri || 
                       item.images?.[0]?.url || 
                       item.image;
      const url = `https://www.coles.com.au/product/${item.slug || id}`;

      if (id && name) {
        products.push({
          id: String(id),
          name: String(name).trim(),
          category,
          current_price: price ? parseFloat(price) : null,
          image_url: imageUrl || null,
          url,
          last_updated: new Date().toISOString(),
        });
      }
    } catch (e) {
      // skip malformed entries
    }
  }
  return products;
}

// Save products to Supabase in batches
async function saveProducts(supabase, products) {
  if (!products.length) return;
  const today = new Date().toISOString().split("T")[0];

  // Upsert products
  for (let i = 0; i < products.length; i += 100) {
    const batch = products.slice(i, i + 100);
    const { error } = await supabase
      .from("products")
      .upsert(batch, { onConflict: "id" });
    if (error) console.error("[Supabase] Product upsert error:", error.message);
  }

  // Save price history
  const historyRows = products
    .filter((p) => p.current_price != null)
    .map((p) => ({
      product_id: p.id,
      price: p.current_price,
      recorded_at: today,
    }));

  for (let i = 0; i < historyRows.length; i += 100) {
    const batch = historyRows.slice(i, i + 100);
    const { error } = await supabase
      .from("price_history")
      .upsert(batch, { onConflict: "product_id,recorded_at" });
    if (error) console.error("[Supabase] History upsert error:", error.message);
  }

  console.log(`[Supabase] Saved ${products.length} products, ${historyRows.length} price records`);
}

// Crawl all categories
async function crawlCatalog() {
  console.log("[Catalog] Starting API-based catalog crawl...");
  const supabase = getSupabase();
  let totalProducts = 0;

  for (const category of CATEGORIES) {
    console.log(`[Catalog] Crawling: ${category}`);
    let page = 1;
    let categoryTotal = 0;
    const MAX_PAGES = 15;

    while (page <= MAX_PAGES) {
      const data = await fetchCategoryPage(category, page);
      if (!data) break;

      const products = extractProducts(data, category);
      if (!products.length) {
        console.log(`[Catalog] ${category} — no more products at page ${page}`);
        break;
      }

      await saveProducts(supabase, products);
      categoryTotal += products.length;
      console.log(`[Catalog] ${category} page ${page}: ${products.length} products`);

      // Check if there are more pages
      const totalCount = data?.pageProps?.searchResults?.noOfResults ||
                         data?.noOfResults ||
                         data?.totalCount || 0;
      if (categoryTotal >= totalCount || products.length < 48) break;

      page++;
      // Small delay between pages
      await new Promise((r) => setTimeout(r, 500));
    }

    totalProducts += categoryTotal;
    console.log(`[Catalog] ${category} done: ${categoryTotal} products`);

    // Delay between categories
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`[Catalog] Complete! Total: ${totalProducts} products`);
  return totalProducts;
}

module.exports = { crawlCatalog };
