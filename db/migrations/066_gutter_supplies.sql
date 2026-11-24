-- Tyler, 2026-11-24: the "Downspouts & elbows" section is now "Gutter Supplies" (label only,
-- the category stays 'downspout'), and gutter coil is sold by the foot in two widths.
-- Tyler sets the prices on the Price list page.
WITH new_coil (sku, name, girth) AS (VALUES
  ('GUT-COIL-5', 'Gutter Coil 5" (11 7/8")', 11.875),
  ('GUT-COIL-6', 'Gutter Coil 6" (15")', 15.000)
)
INSERT INTO products (sku, name, category, pricing_unit, taxable, price_varies, track_stock, girth_in, qbo_item_name)
SELECT n.sku, n.name, 'downspout', 'lf', true, true, false, n.girth, n.name
FROM new_coil n
WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.sku = n.sku);
