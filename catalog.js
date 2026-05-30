/**
 * Coles Catalog Crawler v5
 * Uses the correct Coles _next/data API endpoints
 * First fetches the build ID, then uses it for all category requests
 */

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-AU,en;q=0.9",
  "Referer": "https://www.coles.com.au/",
  "Cookie": "fulfillmentStoreId=0357; shopping-method=delivery",
};

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

// Step 1: Get the Next.js build ID from the Coles homepage
async function getBuildId() {
  try {
    console.log("[Catalog] Fetching Coles build ID...");
    const res = await fetch("https://www.coles.com.au/", {
      headers: HEADERS,
      timeout: 15000,
    });
    const html = await res.text();

    // Extract build ID from __NEXT_DATA__ script tag
    const match = html.match(/"buildId"\s*:\s*"([^"]+)"/);
    if (match) {
      console.log(`[Catalog] Build ID: ${match[1]}`);
      return match[1];
    }

    // Alternative: look in _next/static path references
    const match2 = html.match(/_next\/static\/([a-zA-Z0-9_-]+)\//);
    if (match2) {
      console.log(`[Catalog] Build ID (alt): ${match2[1]}`);
      return match2[1];
    }

    throw new Error("Could not find build ID");
  } catch (err) {
    console.error("[Catalog] Failed to get build ID:", err.message);
    return null;
  }
}

// Step 2: Fetch products for a category page using the build ID
async function fetchCategoryPage(buildId, category, page = 1) {
  const url = `https://www.coles.com.au/_next/data/${buildId}/en/browse/${category}.json?page=${page}&slug=${category}`;
  try {
    const res = await fetch(url, { headers: HEADERS, timeout: 15000 });
    if (!res.ok) {
      console.error(`[API] ${category} page ${page}: HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json;
  } catch (err) {
    console.error(`[API] ${category} page ${page}:`, err.message);
    return null;
  }
}

// Extract product list from Next.js page data
function extractProducts(data, category) {
  const products = [];

  // Navigate the Next.js data structure
  const pageProps = data?.pageProps;
  const searchResults = pageProps?.searchResults ||
                        pageProps?.initialData?.results ||
                        pageProps?.results;

  const results = searchResults?.results ||
                  searchResults?.catalogEntries ||
                  searchResults?.products ||
                  [];

  const totalCount = searchResults?.noOfResults ||
                     searchResults?.totalCount || 0;

  for (const item of results) {
    try {
      const id = String(item.id || item.stockcode || item._id || "").trim();
      const name = (item.name || item.description || "").trim();
      if (!id || !name) continue;

      const pricing = item.pricing || item.price || {};
      const price = pricing.now ?? pricing.current ?? item.nowPrice ?? item.price;

      const slug = item.slug || item.seoToken || id;
      const url = `https://www.coles.com.au/product/${slug}`;

      const imageUrl = item.imageUris?.[0]?.uri ||
                       item.images?.[0]?.url ||
                       item.imageUrl || null;

      products.push({
        id,
        name,
        category,
        current_price: price ? parseFloat(price) : null,
        image_url: imageUrl,
        url,
        last_updated: new Date().toISOString(),
      });
    } catch (e) {
      // skip bad entries
    }
  }

  return { products, totalCount };
}

// Save batch of products to Supabase
async function saveProducts(supabase, products) {
  if (!products.length) return;
  const today = new Date().toISOString().split("T")[0];

  for (let i = 0; i < products.length; i += 100) {
    const batch = products.slice(i, i + 100);
    const { error } = await supabase.from("products")
      .upsert(batch, { onConflict: "id" });
    if (error) console.error("[Supabase] Upsert error:", error.message);
  }

  const historyRows = products
    .filter((p) => p.current_price != null)
    .map((p) => ({ product_id: p.id, price: p.current_price, recorded_at: today }));

  for (let i = 0; i < historyRows.length; i += 100) {
    const batch = historyRows.slice(i, i + 100);
    const { error } = await supabase.from("price_history")
      .upsert(batch, { onConflict: "product_id,recorded_at" });
    if (error) console.error("[Supabase] History error:", error.message);
  }

  console.log(`[Supabase] ✓ Saved ${products.length} products, ${historyRows.length} prices`);
}

// Main catalog crawl
async function crawlCatalog() {
  console.log("[Catalog] Starting Coles catalog crawl v5...");
  const supabase = getSupabase();

  // Get the current build ID first
  const buildId = await getBuildId();
  if (!buildId) {
    console.error("[Catalog] Cannot proceed without build ID");
    return 0;
  }

  let totalProducts = 0;

  for (const category of CATEGORIES) {
    console.log(`[Catalog] Category: ${category}`);
    let page = 1;
    let categoryTotal = 0;
    let totalCount = Infinity;
    const PAGE_SIZE = 48;

    while (categoryTotal < totalCount && page <= 20) {
      const data = await fetchCategoryPage(buildId, category, page);
      if (!data) break;

      const { products, totalCount: tc } = extractProducts(data, category);
      if (tc > 0) totalCount = tc;

      if (!products.length) {
        console.log(`[Catalog] ${category} — no products on page ${page}`);
        break;
      }

      await saveProducts(supabase, products);
      categoryTotal += products.length;
      console.log(`[Catalog] ${category} p${page}: ${products.length} products (${categoryTotal}/${totalCount})`);

      if (products.length < PAGE_SIZE) break;
      page++;
      await new Promise((r) => setTimeout(r, 600));
    }

    totalProducts += categoryTotal;
    console.log(`[Catalog] ${category} complete: ${categoryTotal} products`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`[Catalog] ALL DONE! Total products: ${totalProducts}`);
  return totalProducts;
}

module.exports = { crawlCatalog };
