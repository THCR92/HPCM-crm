-- Downspouts from the two new rollformers (2"x3" and 3"x4"), sold in 10'
-- pieces or custom lengths, plus elbows. No prices yet: the order form asks
-- for one until they're set on the Price list page.
INSERT INTO products (sku, name, category, pricing_unit, standard_length_in, price_varies, qbo_item_name) VALUES
    ('DS-2X3',     'Downspout 2"x3"', 'downspout', 'each', 120,  true, 'Downspout 2"x3"'),
    ('DS-3X4',     'Downspout 3"x4"', 'downspout', 'each', 120,  true, 'Downspout 3"x4"'),
    ('DS-ELB-2X3', 'Elbow 2"x3"',     'downspout', 'each', NULL, true, 'Elbow 2"x3"'),
    ('DS-ELB-3X4', 'Elbow 3"x4"',     'downspout', 'each', NULL, true, 'Elbow 3"x4"')
ON CONFLICT (sku) DO NOTHING;
