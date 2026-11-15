const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error('DATABASE_URL (or POSTGRES_URL) must be set');

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString) || connectionString.includes('host=/');
const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: process.env.VERCEL ? 3 : 10,
});

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  netid       TEXT NOT NULL UNIQUE,
  name        TEXT,
  class_year  TEXT,
  college     TEXT,
  phone       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dresses (
  id              SERIAL PRIMARY KEY,
  owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  designer        TEXT,
  size            TEXT NOT NULL,
  color           TEXT,
  length          TEXT,
  description     TEXT,
  allow_deposit   BOOLEAN NOT NULL DEFAULT true,
  min_deposit     INTEGER NOT NULL DEFAULT 0,
  allow_dryclean  BOOLEAN NOT NULL DEFAULT true,
  allow_swap      BOOLEAN NOT NULL DEFAULT false,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS photos (
  id        SERIAL PRIMARY KEY,
  dress_id  INTEGER NOT NULL REFERENCES dresses(id) ON DELETE CASCADE,
  key       TEXT NOT NULL UNIQUE,
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requests (
  id             SERIAL PRIMARY KEY,
  dress_id       INTEGER NOT NULL REFERENCES dresses(id) ON DELETE CASCADE,
  borrower_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_name     TEXT,
  pickup_date    DATE NOT NULL,
  return_date    DATE NOT NULL,
  terms          TEXT NOT NULL CHECK (terms IN ('deposit','dryclean','swap')),
  deposit_amount INTEGER,
  swap_dress_id  INTEGER REFERENCES dresses(id) ON DELETE SET NULL,
  message        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','declined','cancelled','returned')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dresses_owner ON dresses(owner_id);
CREATE INDEX IF NOT EXISTS idx_photos_dress ON photos(dress_id);
CREATE INDEX IF NOT EXISTS idx_requests_dress ON requests(dress_id);
CREATE INDEX IF NOT EXISTS idx_requests_borrower ON requests(borrower_id);
`;

// Return DATE columns as plain 'YYYY-MM-DD' strings.
require('pg').types.setTypeParser(1082, (v) => v);

let ready;
function init() {
  if (!ready) ready = pool.query(schema).catch((e) => { ready = null; throw e; });
  return ready;
}

async function all(sql, params = []) { await init(); return (await pool.query(sql, params)).rows; }
async function one(sql, params = []) { return (await all(sql, params))[0] || null; }

module.exports = { pool, init, all, one };
