const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data', 'closet.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  netid       TEXT NOT NULL UNIQUE,
  name        TEXT,
  class_year  TEXT,
  college     TEXT,
  phone       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dresses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  designer        TEXT,
  size            TEXT NOT NULL,
  color           TEXT,
  length          TEXT,
  description     TEXT,
  allow_deposit   INTEGER NOT NULL DEFAULT 1,
  min_deposit     INTEGER NOT NULL DEFAULT 0,
  allow_dryclean  INTEGER NOT NULL DEFAULT 1,
  allow_swap      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  dress_id  INTEGER NOT NULL REFERENCES dresses(id) ON DELETE CASCADE,
  filename  TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dress_id       INTEGER NOT NULL REFERENCES dresses(id) ON DELETE CASCADE,
  borrower_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_name     TEXT,
  pickup_date    TEXT NOT NULL,
  return_date    TEXT NOT NULL,
  terms          TEXT NOT NULL CHECK (terms IN ('deposit','dryclean','swap')),
  deposit_amount INTEGER,
  swap_dress_id  INTEGER REFERENCES dresses(id) ON DELETE SET NULL,
  message        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','declined','cancelled','returned')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dresses_owner ON dresses(owner_id);
CREATE INDEX IF NOT EXISTS idx_photos_dress ON photos(dress_id);
CREATE INDEX IF NOT EXISTS idx_requests_dress ON requests(dress_id);
CREATE INDEX IF NOT EXISTS idx_requests_borrower ON requests(borrower_id);
`);

module.exports = db;
