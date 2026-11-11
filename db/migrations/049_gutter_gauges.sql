-- Tyler, 2026-11-11: "Gutter" becomes "Gutter 26 GA", and a "Gutter 24 GA" is added.
-- The 24 ga gutter copies the 26 ga one (lengths, flat width, tax, stock) at the 24 ga
-- trim rate, $4.40 per flat inch (like Parapet Cap 24 GA). Its list price, if the 26 ga
-- one has one, scales the same way ($3.40 -> $4.40). QuickBooks keeps "Gutter" as the
-- 26 ga item's name there; the 24 ga one is made in QuickBooks on its first invoice.
UPDATE products SET name = 'Gutter 26 GA', gauge_id = (SELECT gauge_id FROM gauges WHERE gauge = 26),
       qbo_item_name = COALESCE(qbo_item_name, 'Gutter'), updated_at = now()
WHERE (sku = 'TRM-GUTTER' OR lower(name) = 'gutter')
  AND NOT EXISTS (SELECT 1 FROM products WHERE lower(name) = 'gutter 26 ga');

INSERT INTO products (sku, name, category, pricing_unit, gauge_id, is_cut_to_length, standard_length_in,
                      max_length_in, girth_in, flat_extra_in, pack_size, price_varies, taxable, income_account,
                      track_stock, stock_by_color, bundle_size, price_per_flat_in, trim_type_id, qbo_item_name)
SELECT 'TRM-GUTTER-24', 'Gutter 24 GA', category, pricing_unit, (SELECT gauge_id FROM gauges WHERE gauge = 24),
       is_cut_to_length, standard_length_in, max_length_in, girth_in, flat_extra_in, pack_size, price_varies,
       taxable, income_account, track_stock, stock_by_color, bundle_size, 4.40, trim_type_id, 'Gutter 24 GA'
FROM products
WHERE lower(name) = 'gutter 26 ga'
  AND NOT EXISTS (SELECT 1 FROM products WHERE sku = 'TRM-GUTTER-24' OR lower(name) = 'gutter 24 ga')
ORDER BY product_id LIMIT 1;

INSERT INTO product_prices (product_id, unit_price, effective_from, source)
SELECT n.product_id, round(cp.unit_price * 4.40 / COALESCE(o.price_per_flat_in, 3.40), 2), current_date, 'Gutter 24 GA added'
FROM products n
JOIN products o ON lower(o.name) = 'gutter 26 ga'
JOIN v_current_prices cp ON cp.product_id = o.product_id
WHERE n.sku = 'TRM-GUTTER-24' AND cp.unit_price IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM product_prices pp WHERE pp.product_id = n.product_id)
ON CONFLICT (product_id, effective_from) DO NOTHING;
