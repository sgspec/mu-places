CREATE TABLE IF NOT EXISTS places (place_id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, province TEXT DEFAULT '', district TEXT DEFAULT '', address TEXT DEFAULT '', lat REAL NOT NULL, lng REAL NOT NULL, rating REAL DEFAULT 0, reviews INTEGER DEFAULT 0, image TEXT DEFAULT '', raw TEXT, refreshed_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_cat ON places(category);
CREATE INDEX IF NOT EXISTS idx_prov ON places(province);
CREATE INDEX IF NOT EXISTS idx_reviews ON places(reviews DESC);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
