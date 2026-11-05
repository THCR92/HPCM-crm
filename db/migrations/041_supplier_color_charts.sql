-- Tyler, 2026-11-05: colors from the suppliers' 2026 charts (Sheffield Metals architectural and 26 ga
-- cards, CMG, United Steel Supply, CoilSpot). Metal Wholesale is taken off the lists. Each color lists
-- the gauges it is stocked in (paint-to-order gauges left out); a color with no gauges listed goes
-- with any gauge. Colors already in the CRM keep their id and premium; new ones start with the premium
-- most used for their finish. Colors of these suppliers that aren't on the charts are hidden, not
-- deleted, so old quotes, orders and coils keep them.

INSERT INTO gauges (gauge, nominal_thickness_in, weight_lb_per_sqft) VALUES (28, 0.0149, 0.7500) ON CONFLICT (gauge) DO NOTHING;

CREATE TABLE color_gauges (
    color_id int NOT NULL REFERENCES colors ON DELETE CASCADE,
    gauge_id smallint NOT NULL REFERENCES gauges,
    PRIMARY KEY (color_id, gauge_id)
);

ALTER TABLE suppliers ADD COLUMN active boolean NOT NULL DEFAULT true;

CREATE TEMP TABLE chart (supplier text, name text, finish text, gauges int[], code text, note text) ON COMMIT DROP;
INSERT INTO chart VALUES
    ('Sheffield Metals', 'Acrylic Coated Galvalume', 'unpainted', '{22,24,26}', NULL, NULL),
    ('Sheffield Metals', 'Ash Gray', 'smooth', '{24}', NULL, NULL),
    ('Sheffield Metals', 'Burgundy', 'smooth', '{24}', NULL, 'Sheffield: slight price premium'),
    ('Sheffield Metals', 'Burnished Slate', 'smooth', '{24}', NULL, NULL),
    ('Sheffield Metals', 'Champagne Metallic', 'metallic', '{24}', NULL, 'Sheffield: metallic premium'),
    ('Sheffield Metals', 'Charcoal Gray', 'smooth', '{22,24}', NULL, NULL),
    ('Sheffield Metals', 'Colonial Red', 'smooth', '{24}', NULL, NULL),
    ('Sheffield Metals', 'Copper Metallic', 'metallic', '{24}', NULL, 'Sheffield: metallic premium'),
    ('Sheffield Metals', 'Cor-Ten AZP Raw', 'premium', '{24}', NULL, 'Sheffield: weathered premium'),
    ('Sheffield Metals', 'Dark Bronze', 'smooth', '{22,24}', NULL, NULL),
    ('Sheffield Metals', 'Dove Gray', 'smooth', '{22,24}', NULL, NULL),
    ('Sheffield Metals', 'Evergreen', 'smooth', '{24}', NULL, NULL),
    ('Sheffield Metals', 'Hartford Green', 'smooth', '{24}', NULL, 'Sheffield: slight price premium'),
    ('Sheffield Metals', 'Hemlock Green', 'smooth', '{24}', NULL, 'Sheffield: slight price premium'),
    ('Sheffield Metals', 'Mansard Brown', 'smooth', '{22,24}', NULL, NULL),
    ('Sheffield Metals', 'Matte Black', 'smooth', '{22,24}', NULL, NULL),
    ('Sheffield Metals', 'Medium Bronze', 'smooth', '{22,24}', NULL, NULL),
    ('Sheffield Metals', 'Patina Green', 'smooth', '{24}', NULL, NULL),
    ('Sheffield Metals', 'Pre-Weathered Galvalume', 'metallic', '{24}', NULL, 'Sheffield: metallic premium'),
    ('Sheffield Metals', 'Regal Blue', 'smooth', '{24}', NULL, 'Sheffield: slight price premium'),
    ('Sheffield Metals', 'Regal Red', 'smooth', '{24}', NULL, 'Sheffield: slight price premium'),
    ('Sheffield Metals', 'Regal White', 'smooth', '{22,24}', NULL, NULL),
    ('Sheffield Metals', 'Sandstone', 'smooth', '{24}', NULL, NULL),
    ('Sheffield Metals', 'Sierra Tan', 'smooth', '{24}', NULL, NULL),
    ('Sheffield Metals', 'Silver Metallic', 'metallic', '{24}', NULL, 'Sheffield: metallic premium'),
    ('Sheffield Metals', 'Slate Blue', 'smooth', '{24}', NULL, NULL),
    ('Sheffield Metals', 'Slate Gray', 'smooth', '{22,24}', NULL, NULL),
    ('Sheffield Metals', 'Solar White', 'smooth', '{24}', NULL, NULL),
    ('Sheffield Metals', 'Stone White', 'smooth', '{24}', NULL, NULL),
    ('Sheffield Metals', 'Surrey Beige', 'smooth', '{24}', NULL, NULL),
    ('Sheffield Metals', 'Terra Cotta', 'smooth', '{24}', NULL, NULL),
    ('Sheffield Metals', 'TLG Black', 'textured', '{24}', NULL, 'Sheffield: slight price premium'),
    ('Sheffield Metals', 'TLG Charcoal Gray', 'textured', '{24}', NULL, 'Sheffield: slight price premium'),
    ('Sheffield Metals', 'TLG Dark Bronze', 'textured', '{24}', NULL, 'Sheffield: slight price premium'),
    ('Sheffield Metals', 'TLG Medium Bronze', 'textured', '{24}', NULL, 'Sheffield: slight price premium'),
    ('Sheffield Metals', 'TLG Moonstone', 'textured', '{24}', NULL, 'Sheffield: metallic premium'),
    ('Sheffield Metals', 'Antique', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Ash Gray', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Black', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Charcoal Gray', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Colonial Red', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Dark Bronze', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Dark Gray', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Dove Gray', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Evergreen', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Mansard Brown', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Medium Bronze', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Regal White', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Sandstone', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Sierra Tan', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Slate Gray', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Terra Cotta', 'low_gloss', '{26}', NULL, NULL),
    ('Sheffield Metals', 'Crinkle Coat Black', 'textured', '{26}', NULL, 'Textured SMP'),
    ('Sheffield Metals', 'Crinkle Coat Burnished Slate', 'textured', '{26}', NULL, 'Textured SMP'),
    ('Sheffield Metals', 'Crinkle Coat Charcoal Gray', 'textured', '{26}', NULL, 'Textured SMP'),
    ('Sheffield Metals', 'Crinkle Coat Evergreen', 'textured', '{26}', NULL, 'Textured SMP'),
    ('Sheffield Metals', 'Crinkle Coat Regal White', 'textured', '{26}', NULL, 'Textured SMP'),
    ('Coated Metals Group (CMG)', 'Galvalume Plus', 'unpainted', '{22,24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Aged Copper', 'metallic', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Almond', 'smooth', '{22,24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Antique Ivory', 'smooth', '{26,28}', NULL, 'SMP only'),
    ('Coated Metals Group (CMG)', 'Ash Gray', 'smooth', '{24,26}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Bone White', 'smooth', '{22,24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Bright White', 'smooth', '{24,26}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Burgundy', 'smooth', '{24,26}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Burnished Slate', 'smooth', '{24,26}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Champagne', 'metallic', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Charcoal Gray', 'smooth', '{22,24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Cityscape', 'smooth', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Classic Green', 'smooth', '{24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Colonial Red', 'smooth', '{24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Copper Penny', 'metallic', '{24,26}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Dark Bronze', 'smooth', '{22,24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Deep Black', 'smooth', '{22,24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Extra Dark Bronze', 'smooth', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Hartford Green', 'smooth', '{22,24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Hemlock Green', 'smooth', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Mansard Brown', 'smooth', '{22,24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Matte Black', 'smooth', '{22,24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Medium Bronze', 'smooth', '{22,24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Musket Gray', 'smooth', '{24,26}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Pebble Clay', 'smooth', '{26,28}', NULL, 'SMP only'),
    ('Coated Metals Group (CMG)', 'Regal Red', 'smooth', '{24,26}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Royal Blue', 'smooth', '{24,26}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Sandstone', 'smooth', '{22,24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Sierra Tan', 'smooth', '{22,24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Silver', 'metallic', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Slate Blue', 'smooth', '{24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Slate Gray', 'smooth', '{22,24,26,28}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Stone White', 'smooth', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Teal', 'smooth', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Terra Cotta', 'smooth', '{24,26}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Weathered Zinc', 'metallic', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'ULG Burnished Slate', 'low_gloss', '{24}', NULL, 'Ultra low gloss PVDF'),
    ('Coated Metals Group (CMG)', 'ULG Carbon', 'low_gloss', '{24}', NULL, 'Ultra low gloss PVDF'),
    ('Coated Metals Group (CMG)', 'ULG Charcoal Gray', 'low_gloss', '{24}', NULL, 'Ultra low gloss PVDF'),
    ('Coated Metals Group (CMG)', 'ULG Dark Bronze', 'low_gloss', '{24}', NULL, 'Ultra low gloss PVDF'),
    ('Coated Metals Group (CMG)', 'ULG Deep Black', 'low_gloss', '{22,24}', NULL, 'Ultra low gloss PVDF'),
    ('Coated Metals Group (CMG)', 'ULG Iron Ore', 'low_gloss', '{24}', NULL, 'Ultra low gloss PVDF'),
    ('Coated Metals Group (CMG)', 'ULG Slate Gray', 'low_gloss', '{24}', NULL, 'Ultra low gloss PVDF'),
    ('Coated Metals Group (CMG)', '3D Burgundy', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Burnished Slate', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Charcoal Gray', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Classic Green', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Colonial Red', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Dark Bronze', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Hartford Green', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Mansard Brown', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Matte Black', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Medium Bronze', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Musket Gray', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Sierra Tan', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Slate Gray', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', '3D Terra Cotta', 'textured', '{26}', NULL, 'Textur3D SMP'),
    ('Coated Metals Group (CMG)', 'A606 Weathering Steel', 'unpainted', '{22}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Black Ore', 'premium', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Bonderized', 'unpainted', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Chestnut', 'premium', '{24,26}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Dark Walnut', 'premium', '{24,26}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Driftwood Gray', 'premium', '{24,26}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Rustic Rawhide', 'premium', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Vintage', 'premium', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'Western Rust', 'premium', '{24}', NULL, NULL),
    ('Coated Metals Group (CMG)', 'White Oak', 'premium', '{24,26}', NULL, NULL),
    ('United Steel Supply', 'Acrylic Galvalume', 'unpainted', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Antique Bronze', 'smooth', '{29}', NULL, NULL),
    ('United Steel Supply', 'Arctic White', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Ash Gray', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Burnished Slate', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Berry', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Black', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Bone White', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Brown', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Buckskin', 'smooth', '{29}', NULL, NULL),
    ('United Steel Supply', 'Charcoal Gray', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Charcoal Gray II', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Charcoal Blue Gray', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Colony Green', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Cool White', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Copper Metallic', 'metallic', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Crimson Red', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Dark Brown', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Dark Red', 'smooth', '{29}', NULL, NULL),
    ('United Steel Supply', 'Desert Sand', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Evergreen', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Fern Green', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Gallery Blue', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Hawaiian Blue', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Ivory', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Ivy Green', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Koko Brown', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Light Brown', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Light Stone', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Matte Black', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Old Town Gray', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Polar White', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Rural Red', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Rustic Red', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Saddle Tan', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Taupe', 'smooth', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'ULG Arctic White', 'low_gloss', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'ULG Black', 'low_gloss', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'ULG Burnished Slate', 'low_gloss', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'ULG Charcoal Gray', 'low_gloss', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Crinkle Arctic White', 'textured', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Crinkle Black', 'textured', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Crinkle Burnished Slate', 'textured', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Crinkle Charcoal Gray', 'textured', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Crinkle Evergreen', 'textured', '{29}', NULL, NULL),
    ('United Steel Supply', 'Crinkle Koko Brown', 'textured', '{26,29}', NULL, NULL),
    ('United Steel Supply', 'Crinkle Rustic Red', 'textured', '{29}', NULL, NULL),
    ('CoilSpot', 'Crinkle Ash Gray', 'textured', '{29}', 'CAG', NULL),
    ('CoilSpot', 'Crinkle Brilliant White', 'textured', '{29}', 'CBW', NULL),
    ('CoilSpot', 'Crinkle Brown', 'textured', '{29}', 'CBN', NULL),
    ('CoilSpot', 'Crinkle Burgundy', 'textured', '{29}', 'CBG', NULL),
    ('CoilSpot', 'Crinkle Burnished Slate', 'textured', '{29}', 'CBS', NULL),
    ('CoilSpot', 'Crinkle Charcoal', 'textured', '{29}', 'CCH', NULL),
    ('CoilSpot', 'Crinkle Dark Blue', 'textured', '{29}', 'CDB', NULL),
    ('CoilSpot', 'Crinkle Dark Green', 'textured', '{29}', 'CDG', NULL),
    ('CoilSpot', 'Crinkle Gallery Blue', 'textured', '{29}', 'CGB', NULL),
    ('CoilSpot', 'Crinkle Graphite', 'textured', '{29}', 'CGR', NULL),
    ('CoilSpot', 'Crinkle Matte Black', 'textured', '{29}', 'CMB', NULL),
    ('CoilSpot', 'Crinkle Rustic Red', 'textured', '{29}', 'CRU', NULL),
    ('CoilSpot', 'Crinkle Taupe', 'textured', '{29}', 'CTA', NULL),
    ('CoilSpot', 'Alamo White', 'smooth', '{29}', 'AL', NULL),
    ('CoilSpot', 'Ash Gray', 'smooth', '{29}', 'AG', NULL),
    ('CoilSpot', 'Acrylic Galvalume', 'unpainted', '{29}', 'BA', NULL),
    ('CoilSpot', 'Brilliant White', 'smooth', '{29}', 'BW', NULL),
    ('CoilSpot', 'Brite Red', 'smooth', '{29}', 'BR', NULL),
    ('CoilSpot', 'Brown', 'smooth', '{29}', 'BN', NULL),
    ('CoilSpot', 'Buckskin', 'smooth', '{29}', 'BU', NULL),
    ('CoilSpot', 'Burgundy', 'smooth', '{29}', 'BG', NULL),
    ('CoilSpot', 'Burnished Slate', 'smooth', '{29}', 'BS', NULL),
    ('CoilSpot', 'Charcoal', 'smooth', '{29}', 'CH', NULL),
    ('CoilSpot', 'Copper Metallic', 'metallic', '{29}', 'CM', NULL),
    ('CoilSpot', 'Dark Green', 'smooth', '{29}', 'DG', NULL),
    ('CoilSpot', 'Gallery Blue', 'smooth', '{29}', 'GB', NULL),
    ('CoilSpot', 'Hunter Green', 'smooth', '{29}', 'HU', NULL),
    ('CoilSpot', 'Ivory', 'smooth', '{29}', 'IV', NULL),
    ('CoilSpot', 'Light Stone', 'smooth', '{29}', 'LS', NULL),
    ('CoilSpot', 'Matte Black', 'smooth', '{29}', 'MB', NULL),
    ('CoilSpot', 'Ocean', 'smooth', '{29}', 'OC', NULL),
    ('CoilSpot', 'Pewter Gray', 'smooth', '{29}', 'PG', NULL),
    ('CoilSpot', 'Rustic Red', 'smooth', '{29}', 'RU', NULL),
    ('CoilSpot', 'Tan', 'smooth', '{29}', 'TN', NULL),
    ('CoilSpot', 'Taupe', 'smooth', '{29}', 'TA', NULL);

-- Finishes: low gloss and unpainted are new; use Tyler's own if he already made one by that name.
CREATE TEMP TABLE finish_map (code text PRIMARY KEY, finish text) ON COMMIT DROP;
DO $$
DECLARE f record; k text;
BEGIN
    FOR f IN SELECT * FROM (VALUES ('smooth', 'Smooth', 1), ('textured', 'Textured', 2), ('metallic', 'Metallic', 3),
            ('premium', 'Premium', 4), ('low_gloss', 'Low gloss', 6), ('unpainted', 'Unpainted', 7)) v(code, label, sort) LOOP
        SELECT finish INTO k FROM color_finishes WHERE finish = f.code OR lower(label) = lower(f.label) ORDER BY finish = f.code DESC LIMIT 1;
        IF k IS NULL THEN
            INSERT INTO color_finishes (finish, label, sort_order) VALUES (f.code, f.label, f.sort) RETURNING finish INTO k;
        END IF;
        INSERT INTO finish_map VALUES (f.code, k);
    END LOOP;
END $$;
UPDATE chart c SET finish = m.finish FROM finish_map m WHERE m.code = c.finish;

-- Suppliers: the ones already in the CRM under any spelling, or new.
CREATE TEMP TABLE chart_suppliers (supplier text PRIMARY KEY, pattern text, supplier_id int) ON COMMIT DROP;
INSERT INTO chart_suppliers (supplier, pattern) VALUES
    ('Sheffield Metals', 'sheffield'), ('Coated Metals Group (CMG)', '(\mcmg\M|coated metal)'),
    ('United Steel Supply', '(united steel|^uss\M)'), ('CoilSpot', 'coil ?spot');
UPDATE chart_suppliers cs SET supplier_id = (SELECT s.supplier_id FROM suppliers s WHERE s.name ~* cs.pattern ORDER BY s.supplier_id LIMIT 1);
INSERT INTO suppliers (name) SELECT supplier FROM chart_suppliers WHERE supplier_id IS NULL ON CONFLICT (name) DO NOTHING;
UPDATE chart_suppliers cs SET supplier_id = s.supplier_id FROM suppliers s WHERE cs.supplier_id IS NULL AND s.name = cs.supplier;
UPDATE suppliers SET active = true WHERE supplier_id IN (SELECT supplier_id FROM chart_suppliers);

-- Colors already there (same supplier, name and finish) are kept and shown; the rest are added.
UPDATE colors c SET active = true, is_stock_color = true,
       manufacturer_code = COALESCE(ch.code, c.manufacturer_code), paint_system = COALESCE(ch.note, c.paint_system)
FROM chart ch JOIN chart_suppliers cs USING (supplier)
WHERE c.supplier_id = cs.supplier_id AND lower(c.name) = lower(ch.name) AND c.finish = ch.finish;

INSERT INTO colors (supplier_id, name, finish, manufacturer_code, paint_system, is_stock_color, upcharge_pct)
SELECT cs.supplier_id, ch.name, ch.finish, ch.code, ch.note, true,
       COALESCE((SELECT mode() WITHIN GROUP (ORDER BY x.upcharge_pct) FROM colors x
                 WHERE x.finish = ch.finish AND x.active), 0)
FROM chart ch JOIN chart_suppliers cs USING (supplier)
WHERE NOT EXISTS (SELECT 1 FROM colors c WHERE c.supplier_id = cs.supplier_id AND lower(c.name) = lower(ch.name) AND c.finish = ch.finish);

-- Gauges each chart color is stocked in.
INSERT INTO color_gauges (color_id, gauge_id)
SELECT DISTINCT c.color_id, g.gauge_id
FROM chart ch JOIN chart_suppliers cs USING (supplier)
JOIN colors c ON c.supplier_id = cs.supplier_id AND lower(c.name) = lower(ch.name) AND c.finish = ch.finish
JOIN gauges g ON g.gauge = ANY (ch.gauges);

-- These suppliers' colors that aren't on their charts are hidden.
UPDATE colors c SET active = false
WHERE c.supplier_id IN (SELECT supplier_id FROM chart_suppliers) AND c.active
  AND NOT EXISTS (SELECT 1 FROM chart ch JOIN chart_suppliers cs USING (supplier)
                  WHERE c.supplier_id = cs.supplier_id AND lower(c.name) = lower(ch.name) AND c.finish = ch.finish);

-- Metal Wholesale comes off the lists, with its colors.
UPDATE colors SET active = false WHERE supplier_id IN (SELECT supplier_id FROM suppliers WHERE name ~* 'metal\s*wholesale');
UPDATE suppliers SET active = false WHERE name ~* 'metal\s*wholesale';
