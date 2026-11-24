-- Tyler, 2026-11-24: Sheffield's four WoodCraft woodgrain colors, 24 ga only (PVDF).
-- Premium by the 11/11 supplier price review method (extra coil cost rounded up + 2 points):
-- Sheffield 24G WoodCraft coil $2.30/sq ft vs 24G standard $1.90 = +21.1% -> 22 + 2 = 24%.
-- (CMG's woodgrain is +46.7%, which is why the Premium finish's own number is 49%.)
WITH sup AS (SELECT supplier_id FROM suppliers WHERE name ILIKE 'sheffield%' ORDER BY supplier_id LIMIT 1),
woodcraft (name) AS (VALUES ('Golden Oak'), ('Light Walnut'), ('Rosewood'), ('Warm Gray'))
INSERT INTO colors (supplier_id, name, finish, paint_system, is_stock_color, upcharge_pct)
SELECT sup.supplier_id, w.name, 'premium', 'Sheffield WoodCraft woodgrain (PVDF), 24 ga only', true, 24
FROM sup CROSS JOIN woodcraft w
WHERE NOT EXISTS (SELECT 1 FROM colors c WHERE c.supplier_id = sup.supplier_id AND lower(c.name) = lower(w.name) AND c.finish = 'premium');

INSERT INTO color_gauges (color_id, gauge_id)
SELECT c.color_id, g.gauge_id
FROM colors c JOIN suppliers s USING (supplier_id) CROSS JOIN gauges g
WHERE s.name ILIKE 'sheffield%' AND c.finish = 'premium' AND g.gauge = 24
  AND c.name IN ('Golden Oak', 'Light Walnut', 'Rosewood', 'Warm Gray')
ON CONFLICT DO NOTHING;
