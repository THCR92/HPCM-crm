-- Tyler, 2026-11-12: a count in the CRM of customer quotes waiting on the office. A quote a
-- customer sends from the portal waits until someone in the office opens it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS staff_seen_at timestamptz;
-- Quotes already in the CRM have been seen.
UPDATE orders SET staff_seen_at = now() WHERE from_portal AND staff_seen_at IS NULL;
