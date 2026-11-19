-- Tyler, 2026-11-19: some items never come in a color (Wind Cleat 22 GA). A "No color" box on
-- the item's settings keeps the color off its quote and order lines, and off its price.
ALTER TABLE products ADD COLUMN IF NOT EXISTS no_color boolean NOT NULL DEFAULT false;

UPDATE products SET no_color = true
WHERE name ILIKE 'wind cleat%22%' OR sku IN ('SCR-DP3-1', 'SCR-ULP-1-18', 'SCR-PANHEAD-1');

-- Open quotes and orders drop the color on those lines (prices already on them stay).
UPDATE order_items oi SET color_id = NULL
FROM products p, orders o
WHERE p.product_id = oi.product_id AND o.order_id = oi.order_id AND p.no_color
  AND oi.color_id IS NOT NULL AND o.status NOT IN ('invoiced', 'cancelled', 'completed');
