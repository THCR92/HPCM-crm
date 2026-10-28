-- Tyler, 2026-10-28: a square-footage quote can be one panel at the total length (e.g. 2,782').
-- Lengths could only go up to 9,999.999" (833'); now up to 999,999.999" (83,333').
-- Postgres 16 can't change a column that generated columns read, so billable_qty and
-- line_total become plain columns kept by a trigger with the same formulas. The
-- invoice-lines view reads length_in, so it is set aside and put back unchanged.

CREATE FUNCTION fn_order_item_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.billable_qty := CASE NEW.pricing_unit
        WHEN 'sqft' THEN round(NEW.pieces * NEW.length_in * NEW.width_in / 144.0, 2)
        WHEN 'lf'   THEN round(NEW.pieces * NEW.length_in / 12.0, 2)
        ELSE round(NEW.pieces * COALESCE(NEW.length_in / NEW.per_length_in, 1)
                   * COALESCE((NEW.width_in + COALESCE(NEW.width_add_in, 0)) / NEW.per_width_in, 1), 4)
    END;
    NEW.line_total := round(NEW.billable_qty * NEW.unit_price, 2) - NEW.line_discount;
    RETURN NEW;
END $$;

ALTER TABLE order_items ALTER COLUMN line_total DROP EXPRESSION;
ALTER TABLE order_items ALTER COLUMN billable_qty DROP EXPRESSION;
-- Runs after the other BEFORE triggers (they go in name order), once price and unit are set.
CREATE TRIGGER order_items_zz_totals BEFORE INSERT OR UPDATE ON order_items
    FOR EACH ROW EXECUTE FUNCTION fn_order_item_totals();

DO $$
DECLARE def text := pg_get_viewdef('v_order_invoice_lines'::regclass);
BEGIN
    DROP VIEW v_order_invoice_lines;
    ALTER TABLE order_items ALTER COLUMN length_in TYPE numeric(9,3);
    EXECUTE 'CREATE VIEW v_order_invoice_lines AS ' || def;
END $$;
