-- Trim like ridge cap can be ordered wider or narrower than standard. The price
-- list price covers one piece at the product's flat width (products.girth_in,
-- e.g. ridge cap 13") and standard length (10'), so a line scales by both:
-- 10 pcs of 24" ridge cap at 10' = 10 x 24/13 = 18.46 x the list price.
-- The standard width is copied onto the line (per_width_in) like per_length_in.

ALTER TABLE order_items ADD COLUMN per_width_in numeric(6,3) CHECK (per_width_in > 0);
COMMENT ON COLUMN order_items.per_width_in IS 'Each-priced lines: the flat width one unit of price covers (ridge cap 13")';
COMMENT ON COLUMN order_items.width_in IS 'Panel coverage, custom trim girth, or flat width of a sized trim piece';

-- Ridge cap list prices are for 13" wide pieces (Tyler, 2026-10-07).
UPDATE products SET girth_in = 13 WHERE name ILIKE '%ridge cap%' AND girth_in IS NULL;

DROP VIEW v_order_invoice_lines;
DROP VIEW v_order_totals;
ALTER TABLE order_items DROP COLUMN line_total, DROP COLUMN billable_qty;
ALTER TABLE order_items
    ADD COLUMN billable_qty numeric(12,4) GENERATED ALWAYS AS (
        CASE pricing_unit
            WHEN 'sqft' THEN round(pieces * length_in * width_in / 144.0, 2)
            WHEN 'lf'   THEN round(pieces * length_in / 12.0, 2)
            ELSE round(pieces * COALESCE(length_in / per_length_in, 1)
                              * COALESCE(width_in / per_width_in, 1), 2)
        END) STORED,
    ADD COLUMN line_total numeric(12,2) GENERATED ALWAYS AS (
        round(CASE pricing_unit
            WHEN 'sqft' THEN round(pieces * length_in * width_in / 144.0, 2)
            WHEN 'lf'   THEN round(pieces * length_in / 12.0, 2)
            ELSE round(pieces * COALESCE(length_in / per_length_in, 1)
                              * COALESCE(width_in / per_width_in, 1), 2)
        END * unit_price, 2) - line_discount) STORED;

CREATE VIEW v_order_totals AS
SELECT o.order_id, o.order_number,
       COALESCE(sum(oi.line_total), 0)                                  AS lines_subtotal,
       COALESCE(sum(oi.line_total) FILTER (WHERE oi.taxable), 0)        AS taxable_subtotal,
       o.delivery_charge, o.discount_amount, o.deposit_amount,
       COALESCE(sum(oi.line_total), 0) + o.delivery_charge - o.discount_amount AS pre_tax_total
FROM   orders o
LEFT   JOIN order_items oi USING (order_id)
GROUP  BY o.order_id;

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
            SELECT girth_in INTO NEW.per_width_in FROM products WHERE product_id = NEW.product_id;
        END IF;
    END IF;
    RETURN NEW;
END $$;
