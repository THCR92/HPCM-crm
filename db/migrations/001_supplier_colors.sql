-- Colors belong to a supplier: the same color name from two suppliers is a
-- different color (shades don't match), so each is its own row.
-- Colors also have a finish (smooth or textured). upcharge_pct is a price
-- premium that applies to any color: special-order or textured.

ALTER TABLE colors
    ADD COLUMN supplier_id int REFERENCES suppliers,
    ADD COLUMN finish text NOT NULL DEFAULT 'smooth' CHECK (finish IN ('smooth', 'textured'));
ALTER TABLE colors RENAME COLUMN special_order_upcharge_pct TO upcharge_pct;
ALTER TABLE colors DROP CONSTRAINT colors_name_key;
ALTER TABLE colors ADD CONSTRAINT colors_supplier_name_key UNIQUE NULLS NOT DISTINCT (supplier_id, name);
CREATE INDEX colors_supplier_idx ON colors (supplier_id);

-- What people see in lists: "Charcoal Gray (ABC Metals)", "Crinkle Black (ABC Metals, textured)".
CREATE VIEW v_colors AS
SELECT c.*, s.name AS supplier_name,
       c.name || CASE WHEN s.name IS NULL AND c.finish = 'smooth' THEN ''
                      ELSE ' (' || concat_ws(', ', s.name,
                                  CASE WHEN c.finish = 'textured' THEN 'textured' END) || ')'
                 END AS label
FROM colors c LEFT JOIN suppliers s USING (supplier_id);

-- Line pricing: apply the color's premium whether or not it is a stock color.
CREATE OR REPLACE FUNCTION fn_order_item_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    p           products%ROWTYPE;
    cov         numeric;
    price       numeric;
    upcharge    numeric := 0;
BEGIN
    SELECT * INTO p FROM products WHERE product_id = NEW.product_id;

    NEW.pricing_unit := COALESCE(NEW.pricing_unit, p.pricing_unit);
    NEW.taxable      := COALESCE(NEW.taxable, p.taxable);

    IF NEW.width_in IS NULL AND p.profile_id IS NOT NULL THEN
        SELECT coverage_width_in INTO cov FROM panel_profiles WHERE profile_id = p.profile_id;
        NEW.width_in := cov;
    END IF;

    IF NEW.unit_price IS NULL THEN
        SELECT unit_price INTO price FROM v_current_prices WHERE product_id = NEW.product_id;
        IF price IS NULL THEN
            RAISE EXCEPTION 'Product % (%) has no current price; set unit_price on the line',
                p.sku, p.name;
        END IF;
        IF NEW.color_id IS NOT NULL THEN
            SELECT upcharge_pct INTO upcharge FROM colors WHERE color_id = NEW.color_id;
        END IF;
        NEW.unit_price := round(price * (1 + COALESCE(upcharge, 0) / 100.0), 2);
    END IF;

    IF NEW.line_no IS NULL THEN
        SELECT COALESCE(max(line_no), 0) + 1 INTO NEW.line_no
          FROM order_items WHERE order_id = NEW.order_id;
    END IF;
    RETURN NEW;
END $$;

-- A coil's supplier must match its color's supplier (filled in when left blank).
CREATE FUNCTION fn_coil_supplier_matches_color() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    color_supplier int;
BEGIN
    SELECT supplier_id INTO color_supplier FROM colors WHERE color_id = NEW.color_id;
    IF color_supplier IS NOT NULL THEN
        IF NEW.supplier_id IS NULL THEN
            NEW.supplier_id := color_supplier;
        ELSIF NEW.supplier_id <> color_supplier THEN
            RAISE EXCEPTION 'Coil % is from a different supplier than its color', NEW.coil_tag;
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER coils_supplier_matches_color BEFORE INSERT OR UPDATE OF supplier_id, color_id ON coils
    FOR EACH ROW EXECUTE FUNCTION fn_coil_supplier_matches_color();
