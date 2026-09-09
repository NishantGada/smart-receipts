-- Per-receipt metadata: a title, an optional description, the date the
-- transaction actually happened, and the total as printed on the paper for
-- cross-checking what the OCR read.
--
-- `label` was an unused free-text field from the first cut; it becomes `title`
-- rather than sitting alongside a near-duplicate column.
ALTER TABLE receipts RENAME COLUMN label TO title;

ALTER TABLE receipts
  ADD COLUMN description       TEXT,
  -- The date on the receipt, not the date it was uploaded. Backfilled from
  -- created_at for rows that predate this column, which is the best guess
  -- available for them.
  ADD COLUMN transaction_date  DATE,
  -- What the user reads off the receipt, kept separate from
  -- printed_total_cents (which is what Gemini claimed the total was). Holding
  -- both is the whole point: disagreement means the OCR misread something.
  ADD COLUMN stated_total_cents BIGINT;

UPDATE receipts SET transaction_date = created_at::date WHERE transaction_date IS NULL;

ALTER TABLE receipts
  ALTER COLUMN transaction_date SET NOT NULL,
  ALTER COLUMN transaction_date SET DEFAULT CURRENT_DATE;

-- History is listed newest-transaction-first.
CREATE INDEX IF NOT EXISTS receipts_group_txn_date_idx
  ON receipts (group_id, transaction_date DESC, id DESC);

ALTER TABLE receipts ADD CONSTRAINT receipts_stated_total_nonneg
  CHECK (stated_total_cents IS NULL OR stated_total_cents >= 0);
