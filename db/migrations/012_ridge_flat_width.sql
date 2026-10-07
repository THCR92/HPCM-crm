-- Ridge cap is ordered by finished width but cut from a flat strip 1" wider
-- (13" ridge = 14" flat, 24" ridge = 25" flat). products.girth_in stays the
-- standard flat width; products.flat_extra_in is how much wider the flat strip is
-- than the finished piece. Coil footage uses the flat width (a 25" strip fits
-- once across a 48" coil, leaving a 23" drop).
--
-- How a sized piece is priced against the list price is one setting
-- (app_settings.sized_trim_pricing), applied through fn_sized_trim_basis:
--   flat     - by flat width: list x (finished + extra) / standard flat  (24" = 44.20 x 25/14)
--   mixed    - list / standard finished x flat width                    (24" = 44.20 x 25/13)
--   finished - by finished width                                         (24" = 44.20 x 24/13)
-- Each line keeps its basis (per_width_in, width_add_in) so later changes
-- don't reprice written orders.

ALTER TABLE products ADD COLUMN flat_extra_in numeric(6,3) NOT NULL DEFAULT 0 CHECK (flat_extra_in >= 0);
COMMENT ON COLUMN products.flat_extra_in IS 'Flat strip width minus finished width (ridge cap: 1")';
UPDATE products SET girth_in = 14, flat_extra_in = 1 WHERE name ILIKE '%ridge cap%' AND girth_in = 13;

ALTER TABLE order_items ADD COLUMN width_add_in numeric(6,3) CHECK (width_add_in >= 0);
COMMENT ON COLUMN order_items.width_add_in IS 'Sized trim: inches added to width_in before dividing by per_width_in';

INSERT INTO app_settings (key, value) VALUES ('sized_trim_pricing', 'flat');

CREATE FUNCTION fn_sized_trim_basis(pid int, OUT per_width numeric, OUT width_add numeric)
LANGUAGE sql STABLE AS $$
    SELECT CASE s.value WHEN 'flat' THEN p.girth_in ELSE p.girth_in - p.flat_extra_in END,
           CASE s.value WHEN 'finished' THEN 0 ELSE p.flat_extra_in END
    FROM products p
    LEFT JOIN app_settings s ON s.key = 'sized_trim_pricing'
    WHERE p.product_id = pid AND p.girth_in IS NOT NULL AND p.pricing_unit = 'each'
$$;

DROP VIEW v_order_invoice_lines;
DROP VIEW v_order_totals;
ALTER TABLE order_items DROP COLUMN line_total, DROP COLUMN billable_qty;
ALTER TABLE order_items
    ADD COLUMN billable_qty numeric(12,4) GENERATED ALWAYS AS (
        CASE pricing_unit
            WHEN 'sqft' THEN round(pieces * length_in * width_in / 144.0, 2)
            WHEN 'lf'   THEN round(pieces * length_in / 12.0, 2)
            ELSE round(pieces * COALESCE(length_in / per_length_in, 1)
                              * COALESCE((width_in + COALESCE(width_add_in, 0)) / per_width_in, 1), 4)
        END) STORED,
    ADD COLUMN line_total numeric(12,2) GENERATED ALWAYS AS (
        round(CASE pricing_unit
            WHEN 'sqft' THEN round(pieces * length_in * width_in / 144.0, 2)
            WHEN 'lf'   THEN round(pieces * length_in / 12.0, 2)
            ELSE round(pieces * COALESCE(length_in / per_length_in, 1)
                              * COALESCE((width_in + COALESCE(width_add_in, 0)) / per_width_in, 1), 4)
        END * unit_price, 2) - line_discount) STORED;

CREATE VIEW v_order_totals AS
SELECT o.order_id, o.order_number,
       s.lines_subtotal, s.taxable_subtotal,
       o.delivery_charge, o.discount_amount, o.deposit_amount,
       s.lines_subtotal + o.delivery_charge - o.discount_amount        AS pre_tax_total,
       e.tax_exempt, o.tax_rate, t.tax_amount,
       s.lines_subtotal + o.delivery_charge - o.discount_amount + t.tax_amount AS grand_total
FROM   orders o
JOIN   customers c USING (customer_id)
CROSS  JOIN LATERAL (
       SELECT COALESCE(sum(oi.line_total), 0)                           AS lines_subtotal,
              COALESCE(sum(oi.line_total) FILTER (WHERE oi.taxable), 0) AS taxable_subtotal
       FROM order_items oi WHERE oi.order_id = o.order_id) s
CROSS  JOIN LATERAL (SELECT COALESCE(o.tax_exempt, c.tax_exempt) AS tax_exempt) e
CROSS  JOIN LATERAL (
       SELECT CASE WHEN e.tax_exempt OR o.tax_rate IS NULL THEN 0::numeric
                   ELSE round(greatest(s.taxable_subtotal
                          - CASE WHEN s.lines_subtotal > 0
                                 THEN o.discount_amount * s.taxable_subtotal / s.lines_subtotal ELSE 0 END, 0)
                        * o.tax_rate / 100, 2) END AS tax_amount) t;

CREATE VIEW v_order_invoice_lines AS
SELECT oi.order_id,
       o.order_number,
       os.area,
       os.sort_order                 AS section_sort,
       oi.line_no,
       oi.order_item_id,
       p.sku,
       p.name                        AS product_name,
       p.qbo_item_id,
       oi.pricing_unit,
       oi.pieces,
       oi.length_in,
       oi.width_in,
       oi.billable_qty               AS qbo_qty,
       oi.unit_price                 AS qbo_unit_price,
       oi.line_total                 AS qbo_amount,
       oi.taxable,
       COALESCE(oi.description,
         concat_ws(' | ',
           p.name,
           col.name,
           CASE
             WHEN oi.pricing_unit = 'sqft' THEN
               format('%s pcs @ %s x %s" %s = %s sq ft',
                      trim_scale(oi.pieces)::text,
                      fn_format_length(oi.length_in),
                      trim_scale(oi.width_in)::text,
                      CASE WHEN p.category = 'custom_trim' THEN 'girth' ELSE 'coverage' END,
                      to_char(oi.billable_qty, 'FM999990.00'))
             WHEN oi.pricing_unit = 'lf' THEN
               format('%s pcs @ %s = %s LF',
                      trim_scale(oi.pieces)::text,
                      fn_format_length(oi.length_in),
                      to_char(oi.billable_qty, 'FM999990.00'))
             WHEN oi.width_in IS NOT NULL AND oi.per_width_in IS NOT NULL THEN
               format('%s pcs @ %s x %s" wide = %s x %s" x %s pieces',
                      trim_scale(oi.pieces)::text,
                      fn_format_length(COALESCE(oi.length_in, oi.per_length_in)),
                      trim_scale(oi.width_in)::text,
                      trim_scale(oi.billable_qty)::text,
                      trim_scale(oi.per_width_in)::text,
                      fn_format_length(oi.per_length_in))
             WHEN oi.length_in IS NOT NULL AND oi.per_length_in IS NOT NULL THEN
               format('%s pcs @ %s = %s x %s lengths',
                      trim_scale(oi.pieces)::text,
                      fn_format_length(oi.length_in),
                      trim_scale(oi.billable_qty)::text,
                      fn_format_length(oi.per_length_in))
             WHEN oi.length_in IS NOT NULL THEN
               format('%s pcs @ %s', trim_scale(oi.pieces)::text,
                      fn_format_length(oi.length_in))
             ELSE NULL
           END)) AS qbo_description
FROM   order_items oi
JOIN   orders o              USING (order_id)
JOIN   products p            USING (product_id)
LEFT   JOIN colors col       ON col.color_id = oi.color_id
LEFT   JOIN order_sections os ON os.section_id = oi.section_id;

CREATE OR REPLACE FUNCTION fn_order_item_per_length() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.pricing_unit = 'each' THEN
        IF NEW.per_length_in IS NULL THEN
            SELECT standard_length_in INTO NEW.per_length_in FROM products WHERE product_id = NEW.product_id;
        END IF;
        IF NEW.per_width_in IS NULL AND NEW.width_in IS NOT NULL THEN
            SELECT b.per_width, b.width_add INTO NEW.per_width_in, NEW.width_add_in
            FROM fn_sized_trim_basis(NEW.product_id) b;
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- Open orders with sized trim pick up the flat-width rule.
UPDATE order_items oi
SET per_width_in = (fn_sized_trim_basis(oi.product_id)).per_width,
    width_add_in = (fn_sized_trim_basis(oi.product_id)).width_add
FROM orders o
WHERE o.order_id = oi.order_id AND oi.per_width_in IS NOT NULL
  AND (fn_sized_trim_basis(oi.product_id)).per_width IS NOT NULL
  AND o.status IN ('quote', 'confirmed', 'in_production', 'ready');
