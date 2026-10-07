-- Tyler, 2026-10-07: the list price buys the standard piece (13" ridge cap =
-- $44.20, i.e. $3.40 per finished inch). Any other width is priced at that
-- per-inch rate times the flat width it takes from the coil, to recoup some of
-- the drop: 24" ridge = 25" flat = $3.40 x 25 = $85.00. The standard width
-- itself stays at the list price.
--
-- New setting value 'per_inch' (the default now). fn_sized_trim_basis takes
-- the line's width and returns no basis for the standard width, so that line
-- bills as a plain piece.

DROP FUNCTION fn_sized_trim_basis(int);
CREATE FUNCTION fn_sized_trim_basis(pid int, width numeric, OUT per_width numeric, OUT width_add numeric)
LANGUAGE sql STABLE AS $$
    SELECT CASE s.value WHEN 'flat' THEN p.girth_in ELSE p.girth_in - p.flat_extra_in END,
           CASE s.value WHEN 'finished' THEN 0 ELSE p.flat_extra_in END
    FROM products p
    LEFT JOIN app_settings s ON s.key = 'sized_trim_pricing'
    WHERE p.product_id = pid AND p.girth_in IS NOT NULL AND p.pricing_unit = 'each'
      AND width IS NOT NULL
      AND NOT (s.value = 'per_inch' AND width = p.girth_in - p.flat_extra_in)
$$;

UPDATE app_settings SET value = 'per_inch', updated_at = now() WHERE key = 'sized_trim_pricing';

CREATE OR REPLACE FUNCTION fn_order_item_per_length() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.pricing_unit = 'each' THEN
        IF NEW.per_length_in IS NULL THEN
            SELECT standard_length_in INTO NEW.per_length_in FROM products WHERE product_id = NEW.product_id;
        END IF;
        IF NEW.per_width_in IS NULL AND NEW.width_in IS NOT NULL THEN
            SELECT b.per_width, b.width_add INTO NEW.per_width_in, NEW.width_add_in
            FROM fn_sized_trim_basis(NEW.product_id, NEW.width_in) b;
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- Reprice open orders' sized trim lines with the new rule.
UPDATE order_items oi
SET per_width_in = (fn_sized_trim_basis(oi.product_id, oi.width_in)).per_width,
    width_add_in = (fn_sized_trim_basis(oi.product_id, oi.width_in)).width_add
FROM orders o
WHERE o.order_id = oi.order_id AND oi.per_width_in IS NOT NULL
  AND o.status IN ('quote', 'confirmed', 'in_production', 'ready');
