-- ============================================================
-- Coles Price Tracker — Supabase Schema
-- Run this in your Supabase project: SQL Editor → New query
-- ============================================================

-- Table 1: Products being tracked
CREATE TABLE IF NOT EXISTS tracked_products (
  product_id    TEXT PRIMARY KEY,       -- e.g. "coles-full-cream-milk-2l-1234567"
  name          TEXT,                   -- human-readable product name
  url           TEXT NOT NULL,          -- full Coles product URL
  last_price    NUMERIC(10, 2),         -- most recently scraped price
  last_checked  TIMESTAMPTZ,            -- when it was last scraped
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Table 2: Daily price history
CREATE TABLE IF NOT EXISTS price_history (
  id            BIGSERIAL PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES tracked_products(product_id) ON DELETE CASCADE,
  recorded_at   DATE NOT NULL,          -- YYYY-MM-DD (one row per product per day)
  price         NUMERIC(10, 2) NOT NULL,
  UNIQUE(product_id, recorded_at)       -- prevents duplicate entries per day
);

-- Index for fast history lookups
CREATE INDEX IF NOT EXISTS idx_price_history_product_date
  ON price_history (product_id, recorded_at DESC);

-- ── Row Level Security ───────────────────────────────────────────────────
-- Allow public read (extension fetches without auth)
ALTER TABLE tracked_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read tracked_products"
  ON tracked_products FOR SELECT USING (true);

CREATE POLICY "Public read price_history"
  ON price_history FOR SELECT USING (true);

-- Only service_role (your scraper backend) can write
-- (service_role key bypasses RLS automatically — no policy needed for writes)
