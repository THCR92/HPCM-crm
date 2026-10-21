-- Tyler, 2026-10-21: estimates written in QuickBooks come into the CRM as quotes.
-- They're picked up by the same catch-up check as customers (and by webhooks).
ALTER TABLE orders ADD COLUMN qbo_estimate_id text UNIQUE;
-- The QuickBooks item a line came from, so its invoice uses the same item.
ALTER TABLE order_items ADD COLUMN qbo_item_id text;
-- Estimates changed in QuickBooks up to here are in the CRM. Starts when this goes
-- live: older estimates aren't brought in.
ALTER TABLE qbo_connection ADD COLUMN estimates_checked_at timestamptz;
UPDATE qbo_connection SET estimates_checked_at = now();

-- QuickBooks items that don't match an each-priced CRM product come in as this,
-- with the QuickBooks item's name and description on the line.
INSERT INTO products (sku, name, category, pricing_unit, taxable, price_varies)
VALUES ('QBO-ITEM', 'Item from QuickBooks', 'accessory', 'each', true, true)
ON CONFLICT (sku) DO NOTHING;
