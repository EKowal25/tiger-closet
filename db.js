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

ALTER TABLE users ADD COLUMN IF NOT EXISTS email           TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_expires  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_sent_at  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE dresses  ADD COLUMN IF NOT EXISTS open_to_trade     BOOLEAN NOT NULL DEFAULT false;
-- Borrowers can offer several terms at once (deposit and/or dry clean and/or swap).
ALTER TABLE requests ADD COLUMN IF NOT EXISTS offer_deposit  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS offer_dryclean BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS offer_swap     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE requests ALTER COLUMN terms DROP NOT NULL;
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_terms_check;
UPDATE requests SET offer_deposit = (terms = 'deposit'), offer_dryclean = (terms = 'dryclean'), offer_swap = (terms = 'swap'), terms = NULL
  WHERE terms IS NOT NULL;
-- Free loans (e.g. between friends) and non-refundable rental fees.
ALTER TABLE dresses  ADD COLUMN IF NOT EXISTS allow_free  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE dresses  ADD COLUMN IF NOT EXISTS allow_fee   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE dresses  ADD COLUMN IF NOT EXISTS rental_fee  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS offer_free  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS offer_fee   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS fee_amount  INTEGER;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS owner_got_back    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS borrower_got_back BOOLEAN NOT NULL DEFAULT false;

-- Permanent trades: the offerer gives one or more of their dresses for the owner's dress, for keeps.
CREATE TABLE IF NOT EXISTS trades (
  id                SERIAL PRIMARY KEY,
  dress_id          INTEGER NOT NULL REFERENCES dresses(id) ON DELETE CASCADE,
  owner_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offerer_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message           TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','declined','cancelled','completed')),
  owner_confirmed   BOOLEAN NOT NULL DEFAULT false,
  offerer_confirmed BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_items (
  trade_id  INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  dress_id  INTEGER NOT NULL REFERENCES dresses(id) ON DELETE CASCADE,
  PRIMARY KEY (trade_id, dress_id)
);

CREATE INDEX IF NOT EXISTS idx_trades_dress ON trades(dress_id);
CREATE INDEX IF NOT EXISTS idx_trades_offerer ON trades(offerer_id);
CREATE INDEX IF NOT EXISTS idx_trades_owner ON trades(owner_id);
CREATE INDEX IF NOT EXISTS idx_trade_items_dress ON trade_items(dress_id);
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

// Runs fn(q) inside a transaction, where q(sql, params) returns rows.
async function tx(fn) {
  await init();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, init, all, one, tx };
