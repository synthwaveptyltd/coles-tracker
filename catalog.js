/**
 * Coles Catalog Crawler
 * Automatically discovers all products across every Coles category
 * and registers them in Supabase for daily price tracking.
 */

const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

// All Coles browse categories
const CATEGORIES = [
  { slug: "fruit-vegetables",         name: "Fruit & Vegetables" },
  { slug: "meat-seafood-deli",        name: "Meat, Seafood & Deli" },
  { slug: "dairy-eggs-fridge",        name: "Dairy, Eggs & Fridge" },
  { slug: "bakery",                   name: "Bakery" },
  { slug: "pantry",                   name: "Pantry" },
  { slug: "snacks-confectionery",     name: "Snacks & Confectionery" },
  { slug: "drinks",                   name: "Drinks" },
  { slug: "frozen",                   name: "Frozen" },
  { slug: "health-wellness",          name: "Health & Wellness" },
  { slug: "baby",                     name: "Baby" },
  { slug: "household",                name: "Household" },
  { slug: "pet",                      name: "Pet" },
  { slug: "personal-care",            name: "Personal Care" },
  { slug: "liquor",                   name: "Liquor" },
];

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

// Extract all product links from a category listing page
async function extractProductsFromPage(page) {
  return await page.evaluate(() => {
    const products = [];
    // Coles product cards have links to /product/...
    const links = document.querySelectorAll('a[href*="/product/"]');
    links.forEach((link) => {
      const href = link.href;
      const match = href.match(/\/product\/([^/?#]+)/);
      if (!match) return;
      const productId = match[1];

      // Try to get name and price from the card
      const card = link.closest('[class*="product"]') || link.parentElement;
      const nameEl = card?.querySelector('h2, h3, [class*="name"], [class*="title"]');
      const priceEl = card?.querySelector('[class*="price__value"], [class*="price-"]');
      const imgEl = card?.querySelector('img');

      const name = nameEl?.textContent?.trim() || productId;
      const priceRaw = priceEl?.textContent?.replace(/[^0-9.]/g, "");
      const price = priceRaw ? parseFloat(priceRaw) : null;
      const imageUrl = imgEl?.src || null;

      if (productId && name) {
        products.push({ productId, name, price, imageUrl, url: href });
      }
    });
    // Deduplicate by productId
    const seen = new Set();
    return products.filter((p) => {
      if (seen.has(p.productId)) return false;
      seen.add(p.productId);
      return true;
    });
  });
}

// Crawl a single category — handles pagination
async function crawlCategory(browser, category) {
  const baseUrl = `https://www.coles.com.au/browse/${category.slug}`;
  console.log(`[Crawl] Starting category: ${category.name}`);

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  });

  const allProducts = [];
  let pageNum = 1;
  const MAX_PAGES = 20; // max 20 pages per category (~500 products)

  try {
    while (pageNum <= MAX_PAGES) {
      const url = pageNum === 1 ? baseUrl : `${baseUrl}?page=${pageNum}`;
      console.log(`[Crawl] ${category.name} — page ${pageNum}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Wait for product cards to load
      await page.waitForSelector('a[href*="/product/"]', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000); // let lazy images settle

      const products = await extractProductsFromPage(page);
      if (!products.length) {
        console.log(`[Crawl] ${category.name} — no products on page ${pageNum}, stopping`);
        break;
      }

      allProducts.push(...products);
      console.log(`[Crawl] ${category.name} — found ${products.length} products (total: ${allProducts.length})`);

      // Check if "next page" exists
      const hasNext = await page.evaluate(() => {
        const nextBtn = document.querySelector('[aria-label="Next page"], [class*="pagination"] a[rel="next"]');
        return !!nextBtn;
      });

      if (!hasNext) break;
      pageNum++;

      // Polite delay
      await page.waitForTimeout(1500 + Math.random() * 1500);
    }
  } catch (err) {
    console.error(`[Crawl] Error in ${category.name}:`, err.message);
  } finally {
    await page.close();
  }

  return allProducts;
}

// Save batch of products to Supabase
async function saveProducts(supabase, products, category) {
  if (!products.length) return;

  const rows = products.map((p) => ({
    id: p.productId,
    name: p.name,
    url: p.url,
    category: category.name,
    current_price: p.price,
    image_url: p.imageUrl,
    last_updated: new Date().toISOString(),
  }));

  // Upsert in batches of 100
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const { error } = await supabase
      .from("products")
      .upsert(batch, { onConflict: "id", ignoreDuplicates: false });
    if (error) console.error("[Supabase] Upsert error:", error.message);
    else console.log(`[Supabase] Saved ${batch.length} products from ${category.name}`);
  }

  // Also record current prices in price_history
  const today = new Date().toISOString().split("T")[0];
  const historyRows = products
    .filter((p) => p.price != null)
    .map((p) => ({
      product_id: p.productId,
      price: p.price,
      recorded_at: today,
    }));

  for (let i = 0; i < historyRows.length; i += 100) {
    const batch = historyRows.slice(i, i + 100);
    const { error } = await supabase
      .from("price_history")
      .upsert(batch, { onConflict: "product_id,recorded_at" });
    if (error) console.error("[Supabase] History upsert error:", error.message);
  }
}

// Main catalog crawl — runs all categories
async function crawlCatalog() {
  console.log("[Catalog] Starting full Coles catalog crawl...");
  const supabase = getSupabase();

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  let totalProducts = 0;

  for (const category of CATEGORIES) {
    try {
      const products = await crawlCategory(browser, category);
      await saveProducts(supabase, products, category);
      totalProducts += products.length;

      // Pause between categories to be polite
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      console.error(`[Catalog] Failed category ${category.name}:`, err.message);
    }
  }

  await browser.close();
  console.log(`[Catalog] Done! Discovered ${totalProducts} products across ${CATEGORIES.length} categories.`);
  return totalProducts;
}

module.exports = { crawlCatalog };
