-- smart-receipt schema
-- Money is stored as integer cents everywhere. Never floats.
-- name_key columns are GENERATED so normalisation can never drift between
-- the app and the DB: case and whitespace are folded, nothing else.
-- "Whole Milk" and "Milk" stay distinct items; "milk" and " Milk " do not.

BEGIN;

DROP TABLE IF EXISTS item_splits      CASCADE;
DROP TABLE IF EXISTS receipt_items    CASCADE;
DROP TABLE IF EXISTS receipts         CASCADE;
DROP TABLE IF EXISTS split_memory     CASCADE;
DROP TABLE IF EXISTS members          CASCADE;
DROP TABLE IF EXISTS groups           CASCADE;
DROP TYPE  IF EXISTS item_status      CASCADE;
DROP TYPE  IF EXISTS split_mode       CASCADE;

CREATE TYPE item_status AS ENUM ('billable', 'complimentary', 'refunded');
CREATE TYPE split_mode  AS ENUM ('equal', 'shares', 'percent', 'exact');

CREATE TABLE groups (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL CHECK (btrim(name) <> ''),
  name_key   TEXT GENERATED ALWAYS AS
               (lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name_key)
);

CREATE TABLE members (
  id         BIGSERIAL PRIMARY KEY,
  group_id   BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (btrim(name) <> ''),
  name_key   TEXT GENERATED ALWAYS AS
               (lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, name_key)
);

CREATE TABLE receipts (
  id                     BIGSERIAL PRIMARY KEY,
  group_id               BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title                  TEXT,
  description            TEXT,
  -- The date the transaction happened, per the receipt. Distinct from
  -- created_at below, which is when the photo was uploaded.
  transaction_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  currency               TEXT NOT NULL DEFAULT 'USD',
  image_count            INT  NOT NULL DEFAULT 0,
  -- exactly what the paper said, kept for OCR reconciliation
  printed_subtotal_cents BIGINT NOT NULL DEFAULT 0,
  printed_tax_cents      BIGINT NOT NULL DEFAULT 0,
  printed_tip_cents      BIGINT NOT NULL DEFAULT 0,
  printed_total_cents    BIGINT NOT NULL DEFAULT 0,
  -- The total the user read off the paper themselves. Held separately from
  -- printed_total_cents (what the model claimed) so the two can be compared:
  -- a disagreement means the OCR misread something.
  stated_total_cents     BIGINT,
  ocr_json               JSONB,
  -- Upload timestamp. Recorded for future use; nothing in the UI reads it.
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT receipts_stated_total_nonneg
    CHECK (stated_total_cents IS NULL OR stated_total_cents >= 0)
);

CREATE INDEX receipts_group_txn_date_idx
  ON receipts (group_id, transaction_date DESC, id DESC);

CREATE TABLE receipt_items (
  id                BIGSERIAL PRIMARY KEY,
  receipt_id        BIGINT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  position          INT    NOT NULL,
  name              TEXT   NOT NULL,
  name_key          TEXT GENERATED ALWAYS AS
                      (lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))) STORED,
  quantity          NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents  BIGINT NOT NULL DEFAULT 0,
  total_price_cents BIGINT NOT NULL DEFAULT 0,
  status            item_status NOT NULL DEFAULT 'billable',
  mode              split_mode,
  -- position keys the item within its receipt, so two identical names on one
  -- receipt stay separate rows (the old name-matching code could not do this)
  UNIQUE (receipt_id, position)
);

CREATE INDEX receipt_items_name_key_idx ON receipt_items (name_key);

CREATE TABLE item_splits (
  id              BIGSERIAL PRIMARY KEY,
  receipt_item_id BIGINT NOT NULL REFERENCES receipt_items(id) ON DELETE CASCADE,
  member_id       BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- meaning depends on the item's mode: share count, percent, or exact dollars
  raw_value       NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (raw_value >= 0),
  amount_cents    BIGINT NOT NULL DEFAULT 0,
  UNIQUE (receipt_item_id, member_id)
);

-- One row per distinct item spelling per group. This is the prefill cache:
-- last split used for "Whole Milk" in this group wins next time.
CREATE TABLE split_memory (
  id           BIGSERIAL PRIMARY KEY,
  group_id     BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  name_key     TEXT GENERATED ALWAYS AS
                 (lower(btrim(regexp_replace(display_name, '\s+', ' ', 'g')))) STORED,
  mode         split_mode  NOT NULL,
  status       item_status NOT NULL DEFAULT 'billable',
  -- [{ "member_id": 1, "value": 2 }, ...]
  config       JSONB NOT NULL,
  times_used   INT NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, name_key)
);

COMMIT;
