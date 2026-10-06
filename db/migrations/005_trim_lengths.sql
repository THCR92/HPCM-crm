-- Trim is priced per 10' piece. Pieces can now be cut to other lengths (the
-- brake bends up to 20'), so an "each" line with a length is billed in 10'
-- units: 6 pcs @ 12' = 7.2 x the 10' price. The standard length is copied onto
-- the line (per_length_in) so later changes don't alter written orders.
-- Products also get a flat width (girth): how wide a strip of coil one piece
-- takes, which decides how many pieces come out across the coil.

ALTER TABLE products
    ADD COLUMN girth_in      numeric(6,3) CHECK (girth_in > 0),
    ADD COLUMN max_length_in numeric(7,3) CHECK (max_length_in > 0);
COMMENT ON COLUMN products.girth_in IS 'Flat width cut from the coil for one piece (trim stretch-out)';
COMMENT ON COLUMN products.max_length_in IS 'Longest piece the shop can make';
UPDATE products SET max_length_in = 240 WHERE category IN ('trim', 'custom_trim');

ALTER TABLE order_items ADD COLUMN per_length_in numeric(7,3) CHECK (per_length_in > 0);
COMMENT ON COLUMN order_items.per_length_in IS 'Each-priced lines: the length one unit of price covers (120 = 10'')';

-- Rebuild the generated quantity/total columns with the length rule.
DROP VIEW v_order_invoice_lines;
DROP VIEW v_order_totals;
ALTER TABLE order_items DROP COLUMN line_total, DROP COLUMN billable_qty;
ALTER TABLE order_items
    ADD COLUMN billable_qty numeric(12,4) GENERATED ALWAYS AS (
        CASE pricing_unit
            WHEN 'sqft' THEN round(pieces * length_in * width_in / 144.0, 2)
            WHEN 'lf'   THEN round(pieces * length_in / 12.0, 2)
            ELSE CASE WHEN per_length_in IS NOT NULL AND length_in IS NOT NULL
                      THEN round(pieces * length_in / per_length_in, 2)
                      ELSE pieces END
        END) STORED,
    ADD COLUMN line_total numeric(12,2) GENERATED ALWAYS AS (
        round(
            CASE pricing_unit
                WHEN 'sqft' THEN round(pieces * length_in * width_in / 144.0, 2)
                WHEN 'lf'   THEN round(pieces * length_in / 12.0, 2)
                ELSE CASE WHEN per_length_in IS NOT NULL AND length_in IS NOT NULL
                          THEN round(pieces * length_in / per_length_in, 2)
                          ELSE pieces END
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

-- New lines copy the product's standard length for each-priced items.
CREATE FUNCTION fn_order_item_per_length() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.per_length_in IS NULL AND NEW.pricing_unit = 'each' THEN
        SELECT standard_length_in INTO NEW.per_length_in FROM products WHERE product_id = NEW.product_id;
    END IF;
    RETURN NEW;
END $$;
-- Name sorts after order_items_defaults, which sets pricing_unit first.
CREATE TRIGGER order_items_per_length BEFORE INSERT ON order_items
    FOR EACH ROW EXECUTE FUNCTION fn_order_item_per_length();
