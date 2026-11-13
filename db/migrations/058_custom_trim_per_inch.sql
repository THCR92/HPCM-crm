-- Tyler, 2026-11-13: Custom Trim is priced like the other trim (ridge, gable, ...): per
-- 10' piece at the line's flat width (girth) x the per-inch rate, other lengths billed in
-- proportion, up to 20'. Its list price is the rate per flat inch ($3.40 for 26 ga,
-- $4.40 for 24 ga), so the price list stays one number per product.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_check1;
UPDATE products p SET pricing_unit = 'each', standard_length_in = 120,
       price_per_flat_in = cp.unit_price
FROM v_current_prices cp
WHERE cp.product_id = p.product_id AND p.category = 'custom_trim';

-- Lines already written keep their totals: price per sq ft x girth x 120/144 is the same
-- money per 10' piece. (Invoiced and cancelled lines are left as they were.)
UPDATE order_items oi SET pricing_unit = 'each', per_length_in = 120,
       unit_price = round(oi.unit_price * oi.width_in * 120 / 144, 4)
FROM products p, orders o
WHERE p.product_id = oi.product_id AND o.order_id = oi.order_id AND p.category = 'custom_trim'
  AND oi.pricing_unit = 'sqft' AND oi.width_in > 0 AND o.status NOT IN ('invoiced', 'cancelled');
