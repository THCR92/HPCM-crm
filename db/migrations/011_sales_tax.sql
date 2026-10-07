-- Sales tax on quotes and orders, and finer rounding for sized trim.
--
-- Tax: one default rate (app_settings.sales_tax_rate, editable on the Price list
-- page) is copied onto each new order (orders.tax_rate) and can be changed per
-- order. Tax = rate x taxable materials after the order discount (spread over
-- the lines by amount); delivery is not taxed. Tax-exempt customers, or orders
-- marked exempt, pay none. QuickBooks still makes the official invoice.
--
-- Each-priced quantities now keep 4 decimals, so a 24" ridge cap at 10' is
-- 24/13 = 1.8462 pieces and prices at exactly 44.20 x 24/13 = $81.60 each.

CREATE TABLE app_settings (
    key         text PRIMARY KEY,
    value       text NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (key, value) VALUES ('sales_tax_rate', '6');

ALTER TABLE orders ADD COLUMN tax_rate numeric(6,3) CHECK (tax_rate >= 0 AND tax_rate < 100);
COMMENT ON COLUMN orders.tax_rate IS 'Sales tax percent for this order, copied from the default when created';
UPDATE orders SET tax_rate = 6 WHERE status NOT IN ('invoiced', 'cancelled');

CREATE FUNCTION fn_order_tax_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.tax_rate IS NULL THEN
        SELECT value::numeric INTO NEW.tax_rate FROM app_settings WHERE key = 'sales_tax_rate';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER orders_tax_rate BEFORE INSERT ON orders
    FOR EACH ROW EXECUTE FUNCTION fn_order_tax_rate();

DROP VIEW v_order_invoice_lines;
DROP VIEW v_order_totals;
ALTER TABLE order_items DROP COLUMN line_total, DROP COLUMN billable_qty;
ALTER TABLE order_items
    ADD COLUMN billable_qty numeric(12,4) GENERATED ALWAYS AS (
        CASE pricing_unit
            WHEN 'sqft' THEN round(pieces * length_in * width_in / 144.0, 2)
            WHEN 'lf'   THEN round(pieces * length_in / 12.0, 2)
            ELSE round(pieces * COALESCE(length_in / per_length_in, 1)
                              * COALESCE(width_in / per_width_in, 1), 4)
        END) STORED,
    ADD COLUMN line_total numeric(12,2) GENERATED ALWAYS AS (
        round(CASE pricing_unit
            WHEN 'sqft' THEN round(pieces * length_in * width_in / 144.0, 2)
            WHEN 'lf'   THEN round(pieces * length_in / 12.0, 2)
            ELSE round(pieces * COALESCE(length_in / per_length_in, 1)
                              * COALESCE(width_in / per_width_in, 1), 4)
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
