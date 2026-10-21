-- Tyler, 2026-10-21: 26 ga trim is priced at $3.40 per inch of flat width, and the price
-- shown on a line is the price of one piece at its width (so Price x Qty = Amount).
-- Trim with no gauge on the price list is 26 ga (24 ga items say so).
ALTER TABLE products ADD COLUMN price_per_flat_in numeric(8,4) CHECK (price_per_flat_in > 0);
COMMENT ON COLUMN products.price_per_flat_in IS 'Each-priced trim: price per inch of flat width (26 ga: $3.40)';
UPDATE products p SET price_per_flat_in = 3.40
WHERE p.category = 'trim' AND p.pricing_unit = 'each'
  AND (p.gauge_id IS NULL OR p.gauge_id IN (SELECT gauge_id FROM gauges WHERE gauge = 26));

-- Width no longer scales the billed quantity; the piece price carries it.
CREATE OR REPLACE FUNCTION fn_sized_trim_basis(pid int, width numeric, OUT per_width numeric, OUT width_add numeric)
LANGUAGE sql STABLE AS $$ SELECT NULL::numeric, NULL::numeric WHERE false $$;

-- Lines already written: fold the width into the piece price. Amounts stay the same
-- (to the cent), so an order that's reopened and saved again doesn't change.
-- Invoiced and cancelled orders are locked and can't be edited, so they stay as they are.
UPDATE order_items oi
SET unit_price = round(oi.unit_price * (oi.width_in + COALESCE(oi.width_add_in, 0)) / oi.per_width_in, 2),
    per_width_in = NULL, width_add_in = NULL
FROM orders o
WHERE o.order_id = oi.order_id AND oi.per_width_in IS NOT NULL
  AND o.status NOT IN ('invoiced', 'cancelled');
