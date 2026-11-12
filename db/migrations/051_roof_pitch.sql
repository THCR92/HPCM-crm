-- Tyler, 2026-11-12: some trim is bent to the roof pitch. Each item on the price list says
-- whether a line needs the pitch: none, one ("4:12"), or two for a pitch break/transition
-- ("4:12 to 1:12"). The line keeps the pitch as text; the cut sheet shows it.
ALTER TABLE products ADD COLUMN IF NOT EXISTS needs_pitch smallint NOT NULL DEFAULT 0 CHECK (needs_pitch IN (0, 1, 2));
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS pitch text CHECK (length(pitch) <= 40);

-- Pitch breaks and transitions tie two pitches together.
UPDATE products SET needs_pitch = 2
WHERE category = 'trim' AND (name ILIKE '%pitch break%' OR name ILIKE '%transition%');

-- "D Style Eave": a copy of the D style 90 (rake/gable) bent to the roof pitch.
INSERT INTO products (sku, name, category, pricing_unit, gauge_id, is_cut_to_length, standard_length_in, max_length_in,
                      girth_in, flat_extra_in, pack_size, price_varies, taxable, income_account, track_stock,
                      stock_by_color, bundle_size, price_per_flat_in, trim_type_id, qbo_item_name, needs_pitch)
SELECT 'TRM-D-STYLE-EAVE', 'D Style Eave', category, pricing_unit, gauge_id, is_cut_to_length, standard_length_in,
       max_length_in, girth_in, flat_extra_in, pack_size, price_varies, taxable, income_account, track_stock,
       stock_by_color, bundle_size, price_per_flat_in, trim_type_id, 'D Style Eave', 1
FROM products
WHERE category = 'trim' AND active AND (sku = 'TRM-D-STYLE-90' OR name ILIKE 'd%style%90%')
  AND NOT EXISTS (SELECT 1 FROM products WHERE sku = 'TRM-D-STYLE-EAVE' OR lower(name) = 'd style eave')
ORDER BY (sku = 'TRM-D-STYLE-90') DESC, product_id LIMIT 1;

INSERT INTO product_prices (product_id, unit_price, effective_from, source)
SELECT n.product_id, cp.unit_price, current_date, 'Copied from D style 90'
FROM products n
JOIN products o ON o.category = 'trim' AND (o.sku = 'TRM-D-STYLE-90' OR o.name ILIKE 'd%style%90%')
JOIN v_current_prices cp ON cp.product_id = o.product_id
WHERE n.sku = 'TRM-D-STYLE-EAVE' AND cp.unit_price IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM product_prices pp WHERE pp.product_id = n.product_id)
ORDER BY (o.sku = 'TRM-D-STYLE-90') DESC LIMIT 1;

-- A changed pitch un-ticks a line marked done, like a changed length.
CREATE OR REPLACE FUNCTION fn_order_item_undone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.done_at IS NOT NULL AND NEW.done_at IS NOT DISTINCT FROM OLD.done_at
       AND (NEW.product_id, NEW.color_id, NEW.pieces, NEW.length_in, NEW.width_in, NEW.pitch)
           IS DISTINCT FROM (OLD.product_id, OLD.color_id, OLD.pieces, OLD.length_in, OLD.width_in, OLD.pitch) THEN
        NEW.done_at := NULL;
        NEW.done_by := NULL;
        NEW.done_by_name := NULL;
    END IF;
    RETURN NEW;
END $$;
