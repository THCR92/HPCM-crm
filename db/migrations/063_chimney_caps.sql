-- Tyler, 2026-11-19: chimney caps in three sizes, each made from a drawing. Items can now
-- need a size on each line (top length x width and the side height) and a drawing uploaded
-- to the line; a quote can be saved without them, but it can't become an order.
ALTER TABLE products ADD COLUMN IF NOT EXISTS needs_dims boolean NOT NULL DEFAULT false;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS dims text CHECK (length(dims) <= 80);

WITH new_caps (sku, name, price) AS (VALUES
  ('ACC-CHIMNEY-CAP-S', 'Chimney Cap Small (up to 24")', 100.00),
  ('ACC-CHIMNEY-CAP-M', 'Chimney Cap Medium (25" to 32")', 160.00),
  ('ACC-CHIMNEY-CAP-L', 'Chimney Cap Large (33" to 40")', 240.00)
), added AS (
  INSERT INTO products (sku, name, category, pricing_unit, taxable, price_varies, track_stock, needs_dims, qbo_item_name)
  SELECT n.sku, n.name, 'accessory', 'each', true, false, false, true, n.name
  FROM new_caps n
  WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.sku = n.sku)
  RETURNING product_id, sku
)
INSERT INTO product_prices (product_id, unit_price, effective_from, source)
SELECT a.product_id, n.price, current_date, 'Tyler 2026-11-19'
FROM added a JOIN new_caps n USING (sku);
