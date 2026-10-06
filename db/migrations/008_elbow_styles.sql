-- Elbows come in A and B styles, in both downspout sizes, plus short offset
-- elbows in the same styles and sizes. The two plain elbows from 007 become
-- the A-style ones (same products, so any order lines using them keep working).
UPDATE products SET sku = 'DS-ELB-2X3-A', name = 'Elbow 2"x3" A style', qbo_item_name = 'Elbow 2"x3" A style'
 WHERE sku = 'DS-ELB-2X3';
UPDATE products SET sku = 'DS-ELB-3X4-A', name = 'Elbow 3"x4" A style', qbo_item_name = 'Elbow 3"x4" A style'
 WHERE sku = 'DS-ELB-3X4';

INSERT INTO products (sku, name, category, pricing_unit, price_varies, qbo_item_name)
SELECT v.sku, v.name, 'downspout', 'each', true, v.name
FROM (VALUES
    ('DS-ELB-2X3-A',  'Elbow 2"x3" A style'),
    ('DS-ELB-2X3-B',  'Elbow 2"x3" B style'),
    ('DS-ELB-3X4-A',  'Elbow 3"x4" A style'),
    ('DS-ELB-3X4-B',  'Elbow 3"x4" B style'),
    ('DS-SOE-2X3-A',  'Short Offset Elbow 2"x3" A style'),
    ('DS-SOE-2X3-B',  'Short Offset Elbow 2"x3" B style'),
    ('DS-SOE-3X4-A',  'Short Offset Elbow 3"x4" A style'),
    ('DS-SOE-3X4-B',  'Short Offset Elbow 3"x4" B style')
) AS v(sku, name)
ON CONFLICT (sku) DO NOTHING;
