-- Tyler, 2026-10-21: every trim line can take a width, and the width typed is the
-- FLAT width (inches of coil), not the finished width.
--
-- Pricing stays Tyler's 2026-10-07 rule: the list price buys the standard piece; any
-- other width costs the list price per standard finished inch x the flat width
-- (ridge cap: $44.20 / 13" = $3.40; 25" flat = $85.00). So the basis is the standard
-- finished width and nothing is added. A trim with no standard flat width set (girth_in)
-- keeps its list price whatever width is typed; the width still tells the shop the strip.

CREATE OR REPLACE FUNCTION fn_sized_trim_basis(pid int, width numeric, OUT per_width numeric, OUT width_add numeric)
LANGUAGE sql STABLE AS $$
    SELECT p.girth_in - p.flat_extra_in, 0::numeric
    FROM products p
    WHERE p.product_id = pid AND p.girth_in IS NOT NULL AND p.pricing_unit = 'each'
      AND width IS NOT NULL AND width <> p.girth_in
$$;

-- Lines written with a finished width become the flat width. Totals don't move:
-- (finished + extra) / basis is the same as flat / basis.
UPDATE order_items oi
SET width_in = oi.width_in + p.flat_extra_in,
    width_add_in = CASE WHEN oi.per_width_in IS NOT NULL THEN 0 END
FROM products p
WHERE p.product_id = oi.product_id AND p.flat_extra_in > 0 AND oi.width_in IS NOT NULL
  AND oi.pricing_unit = 'each';

UPDATE app_settings SET value = 'per_inch', updated_at = now() WHERE key = 'sized_trim_pricing';

-- Invoice line wording: the width shown is the flat width.
DO $$ BEGIN
  EXECUTE 'CREATE OR REPLACE VIEW v_order_invoice_lines AS '
    || replace(pg_get_viewdef('v_order_invoice_lines'::regclass), '" wide = ', '" flat = ');
END $$;
