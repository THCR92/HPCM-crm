-- Tyler, 2026-11-24: ALL Tru-Steel HD images in the brochure, not just the ones with the
-- USS logo. The other 20, same as 073: Premium finish at 49% (like CMG woodgrain), 24/26/29 ga.
WITH sup AS (SELECT supplier_id FROM suppliers WHERE name ILIKE 'united steel%' ORDER BY supplier_id LIMIT 1),
hd (name) AS (VALUES
  ('Charred Wood'), ('Whitewash Rough Sawn Cedar'), ('Rustic Hickory Plank'), ('Natural Canary'),
  ('Natural Rosewood'), ('Straight Grain Oak'), ('Walnut Tree Bark'),
  ('Black Zebrawood'), ('Blonde Zebrawood'), ('Walnut Zebrawood'),
  ('Mottled Copper'), ('Dark Rust Mottled Copper'), ('Patina Mottled Copper'), ('Rust Mottled Copper'),
  ('Titanium Granite'), ('Dusty Gray Stone'), ('Acadia Ledgestone'), ('Canyon Ledgestone'),
  ('Sierra Brown Flagstone'), ('Mossy Oak Camouflage'))
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
