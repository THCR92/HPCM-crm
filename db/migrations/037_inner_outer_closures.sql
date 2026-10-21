-- Tyler, 2026-10-21: closures come as separate Inner and Outer lines, each profile its own:
-- PBR/R Panel Inner Closure + Outer Closure, Tuff Rib Inner Closure + Outer Closure.
-- Still 1 inside and 1 outside per panel piece. Each new item starts at the price the
-- combined item had (that price was already per closure). Vented quotes keep the inner
-- closure inside and use the vented closure outside.

ALTER TABLE panel_profiles ADD COLUMN outer_closure_product_id int REFERENCES products;

CREATE TEMP TABLE new_closures (profile text, old_sku text, side text, sku text, name text) ON COMMIT DROP;
INSERT INTO new_closures VALUES
    ('PBR/R Panel', 'ACC-PBR-CLOSURE', 'inner', 'ACC-PBR-CLOS-INNER', 'PBR/R Panel Inner Closure'),
    ('PBR/R Panel', 'ACC-PBR-CLOSURE', 'outer', 'ACC-PBR-CLOS-OUTER', 'PBR/R Panel Outer Closure'),
    ('Tuff Rib',    'ACC-CLOS-IO',     'inner', 'ACC-TR-CLOS-INNER',  'Tuff Rib Inner Closure'),
    ('Tuff Rib',    'ACC-CLOS-IO',     'outer', 'ACC-TR-CLOS-OUTER',  'Tuff Rib Outer Closure');

INSERT INTO products (sku, name, category, pricing_unit, taxable, price_varies, qbo_item_name, track_stock, stock_by_color)
SELECT n.sku, n.name, o.category, o.pricing_unit, o.taxable, o.price_varies, n.name, o.track_stock, o.stock_by_color
FROM new_closures n JOIN products o ON o.sku = n.old_sku
ON CONFLICT (sku) DO NOTHING;

INSERT INTO product_prices (product_id, unit_price, effective_from, source)
SELECT p.product_id, cp.unit_price, current_date, 'Tyler 2026-10-21: same price as the combined closure'
FROM new_closures n
JOIN products p ON p.sku = n.sku
JOIN products o ON o.sku = n.old_sku
JOIN v_current_prices cp ON cp.product_id = o.product_id
ON CONFLICT (product_id, effective_from) DO NOTHING;

UPDATE panel_profiles pp SET closure_product_id = p.product_id
FROM new_closures n JOIN products p ON p.sku = n.sku
WHERE n.side = 'inner' AND pp.name = n.profile;
UPDATE panel_profiles pp SET outer_closure_product_id = p.product_id
FROM new_closures n JOIN products p ON p.sku = n.sku
WHERE n.side = 'outer' AND pp.name = n.profile;
