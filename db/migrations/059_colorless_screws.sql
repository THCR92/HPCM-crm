-- Tyler, 2026-11-13: DP3 clip screws, ULP clip screws and 1" panhead screws don't come in
-- colors, so quotes don't put a color on them. (Each screw rule's "matches color" box,
-- Admin > Screws and clips, is what decides this for any other screw.)
UPDATE screw_rules r SET color_match = false
FROM products p
WHERE p.product_id = r.product_id AND p.sku IN ('SCR-DP3-1', 'SCR-ULP-1-18', 'SCR-PANHEAD-1');

UPDATE products SET stock_by_color = false WHERE sku IN ('SCR-DP3-1', 'SCR-ULP-1-18', 'SCR-PANHEAD-1');

-- Open quotes and orders drop the color on those lines.
UPDATE order_items oi SET color_id = NULL
FROM products p, orders o
WHERE p.product_id = oi.product_id AND o.order_id = oi.order_id
  AND p.sku IN ('SCR-DP3-1', 'SCR-ULP-1-18', 'SCR-PANHEAD-1')
  AND oi.color_id IS NOT NULL AND o.status NOT IN ('invoiced', 'cancelled', 'completed');
