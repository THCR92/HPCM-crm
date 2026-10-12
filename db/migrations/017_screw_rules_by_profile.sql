-- Screw rules per panel profile, from Tyler (2026-10-12):
--   PBR / Tuff Rib on wood:  #10 1.5 Woodtite (usual) or 2 1/2" Woodtite #10, 90 per square
--   PBR / Tuff Rib on steel: 1.25" Self Drilling, 90 per square
--   1" Nail Flange standing seam: 1" Panhead, 1 every 2' of panel length
--   Snap Lock (clip) standing seam: 1 clip and 2 panheads every 2' of panel length
-- A rule is either "per square" (100 sq ft) or "every N inches of each panel".
-- Rules with a length are alternatives (the quote picks one); rules without a
-- length always apply. framing 'any' covers wood and steel.

DROP TABLE screw_rules;
CREATE TABLE screw_rules (
    screw_rule_id   serial PRIMARY KEY,
    profile_id      int NOT NULL REFERENCES panel_profiles ON DELETE CASCADE,
    framing         text NOT NULL CHECK (framing IN ('wood', 'steel', 'any')),
    length_label    text,
    product_id      int NOT NULL REFERENCES products,
    basis           text NOT NULL CHECK (basis IN ('square', 'spacing')),
    qty             numeric(8,2) NOT NULL CHECK (qty > 0),   -- per square, or per spacing
    spacing_in      numeric(7,2) CHECK (spacing_in > 0),      -- for 'spacing'
    color_match     boolean NOT NULL DEFAULT true,
    is_default      boolean NOT NULL DEFAULT false,
    sort_order      int NOT NULL DEFAULT 0,
    CHECK (basis = 'square' OR spacing_in IS NOT NULL)
);
CREATE UNIQUE INDEX screw_rules_unique ON screw_rules (profile_id, framing, COALESCE(length_label, ''), product_id);

-- Price-list names, and the 2" screw that turned out not to be needed.
UPDATE products SET name = '#10 1.5 Woodtite Screws' WHERE sku = 'SCR-10-1-5-WOODTITE-SCREWS';
UPDATE products SET pack_size = 250
WHERE sku IN ('SCR-10-1-5-WOODTITE-SCREWS', 'SCR-2-1-2IN-WOODTITE-SCREW-1', 'SCR-SD-125', 'SCR-PANHEAD-1') AND pack_size IS NULL;
DELETE FROM products p WHERE sku = 'SCR-10-2-WOODGRIP'
    AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = p.product_id);
UPDATE products SET active = false WHERE sku = 'SCR-10-2-WOODGRIP';
UPDATE orders SET screw_length = NULL WHERE screw_length = '2"';

INSERT INTO screw_rules (profile_id, framing, length_label, product_id, basis, qty, spacing_in, color_match, is_default, sort_order)
SELECT pp.profile_id, v.framing, v.len, p.product_id, v.basis, v.qty, v.spacing, v.color_match, v.def, v.ord
FROM (VALUES
    ('PBR/R Panel',                  'wood',  '1.5"',     'SCR-10-1-5-WOODTITE-SCREWS',   'square',  90, NULL::numeric, true,  true,  1),
    ('PBR/R Panel',                  'wood',  '2 1/2"',   'SCR-2-1-2IN-WOODTITE-SCREW-1', 'square',  90, NULL,          true,  false, 2),
    ('PBR/R Panel',                  'steel', '1.25"',    'SCR-SD-125',                   'square',  90, NULL,          true,  true,  3),
    ('Tuff Rib',                     'wood',  '1.5"',     'SCR-10-1-5-WOODTITE-SCREWS',   'square',  90, NULL,          true,  true,  1),
    ('Tuff Rib',                     'wood',  '2 1/2"',   'SCR-2-1-2IN-WOODTITE-SCREW-1', 'square',  90, NULL,          true,  false, 2),
    ('Tuff Rib',                     'steel', '1.25"',    'SCR-SD-125',                   'square',  90, NULL,          true,  true,  3),
    ('Standing Seam 1" Nail Flange', 'any',   NULL,       'SCR-PANHEAD-1',                'spacing', 1,  24,            true,  false, 1),
    ('Snap Lock 1.5"',               'any',   NULL,       'ACC-CLIP-15',                  'spacing', 1,  24,            false, false, 1),
    ('Snap Lock 1.5"',               'any',   NULL,       'SCR-PANHEAD-1',                'spacing', 2,  24,            true,  false, 2)
) v(profile, framing, len, sku, basis, qty, spacing, color_match, def, ord)
JOIN panel_profiles pp ON pp.name = v.profile
JOIN products p ON p.sku = v.sku;
