-- Tyler, 2026-11-24: United Steel Supply's Tru-Steel HD printed colors (woodgrains, plus
-- Realtree camo), in 24, 26 and 29 ga. Taken from the Q1 2026 brochure: only the images
-- marked with the United Steel Supply logo. No USS pricing yet, so they're priced like
-- CMG's woodgrains for now: Premium finish at 49%.
WITH sup AS (SELECT supplier_id FROM suppliers WHERE name ILIKE 'united steel%' ORDER BY supplier_id LIMIT 1),
hd (name) AS (VALUES
  ('Rough Edge Barnwood Plank'), ('Gray Distressed Barnwood Plank'), ('Gray Wash Barnwood Plank'),
  ('Black Burnt Wood'), ('Charcoal Burnt Wood'), ('Chippy White'), ('Smooth Cedar'),
  ('Natural Rough Sawn Cedar'), ('Dark Rough Sawn Cedar'), ('Gray Rough Sawn Cedar'), ('Taupe Rough Sawn Cedar'),
  ('Natural Hickory'), ('Dark Oak'), ('Medium Oak'), ('Knotty Alder Plank'), ('Natural Pecky Cypress'),
  ('Primitive Pine Plank'), ('Walnut'), ('Zebrawood'), ('Realtree Camouflage'))
INSERT INTO colors (supplier_id, name, finish, paint_system, is_stock_color, upcharge_pct)
SELECT sup.supplier_id, hd.name, 'premium', 'Tru-Steel HD printed (24, 26, 29 ga)', true, 49
FROM sup CROSS JOIN hd
WHERE NOT EXISTS (SELECT 1 FROM colors c WHERE c.supplier_id = sup.supplier_id AND lower(c.name) = lower(hd.name) AND c.finish = 'premium');

INSERT INTO color_gauges (color_id, gauge_id)
SELECT c.color_id, g.gauge_id
FROM colors c JOIN suppliers s USING (supplier_id) CROSS JOIN gauges g
WHERE s.name ILIKE 'united steel%' AND c.finish = 'premium' AND c.paint_system LIKE 'Tru-Steel HD%'
  AND g.gauge IN (24, 26, 29)
ON CONFLICT DO NOTHING;
