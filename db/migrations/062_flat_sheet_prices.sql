-- Tyler, 2026-11-19: flat sheets (4' x 10') priced from the supplier price sheets by gauge and
-- finish, at a 35% margin (price = cost / 0.65, rounded up to the cent). Sources: CMG price
-- sheet 8/17/2026 and Sheffield Metals 10/1/2026. A color's own supplier sets its cost; colors
-- from other suppliers (CoilSpot, United Steel Supply) use the higher of the two sheets.
CREATE TABLE IF NOT EXISTS flat_sheet_costs (
    flat_sheet_cost_id serial PRIMARY KEY,
    gauge          smallint      NOT NULL,
    supplier_like  text,                    -- NULL = any supplier
    finishes       text[],                  -- color finishes this cost is for
    color_names    text[],                  -- or these colors by name (beats finish)
    cost           numeric(10,2) NOT NULL CHECK (cost >= 0),
    note           text,
    CHECK (finishes IS NOT NULL OR color_names IS NOT NULL)
);

INSERT INTO flat_sheet_costs (gauge, supplier_like, finishes, color_names, cost, note)
SELECT * FROM (VALUES
  -- Sheffield Metals (10/1/2026)
  (22, 'Sheffield%', '{smooth,pvdf_heat_reflective}'::text[], NULL::text[], 92.80, 'Sheffield 22G PVDF standard'),
  (22, 'Sheffield%', NULL, '{Champagne,Pre-Weathered Galvalume,Vintage,Regal Red,Burgundy,Regal Blue,Hemlock Green,Hartford Green}', 94.80, 'Sheffield 22G PVDF premium color'),
  (24, 'Sheffield%', '{smooth,pvdf_heat_reflective}', NULL, 78.80, 'Sheffield 24G PVDF standard'),
  (24, 'Sheffield%', NULL, '{Pre-Weathered Galvalume,Vintage,Regal Red,Burgundy,Regal Blue,Hemlock Green,Hartford Green}', 80.80, 'Sheffield 24G PVDF premium color'),
  (24, 'Sheffield%', '{metallic,textured,low_gloss}', NULL, 82.80, 'Sheffield 24G metallic / textured low gloss'),
  (24, 'Sheffield%', '{premium}', NULL, 94.80, 'Sheffield 24G woodgrain'),
  (24, 'Sheffield%', NULL, '{Cor-Ten AZP Raw,Cor Ten AZP,Rustic Rawhide,Steel Gray Rawhide,Burnished Slate Rawhide}', 101.30, 'Sheffield 24G weathered'),
  (24, 'Sheffield%', '{unpainted}', NULL, 50.00, 'Sheffield 24G Galvalume'),
  (26, 'Sheffield%', '{smooth,pvdf_heat_reflective}', NULL, 55.60, 'Sheffield 26G SMP standard'),
  (26, 'Sheffield%', NULL, '{Champagne,Pre-Weathered Galvalume,Vintage,Regal Red,Burgundy,Regal Blue,Hemlock Green,Hartford Green}', 58.00, 'Sheffield 26G SMP premium color'),
  (26, 'Sheffield%', '{unpainted}', NULL, 46.00, 'Sheffield 26G Galvalume'),
  -- Coated Metals Group (8/17/2026)
  (22, 'Coated Metals%', '{smooth,pvdf_heat_reflective}', NULL, 94.37, 'CMG 22 ga PVDF standard'),
  (24, 'Coated Metals%', '{smooth,pvdf_heat_reflective}', NULL, 76.44, 'CMG 24 ga PVDF standard'),
  (24, 'Coated Metals%', '{metallic}', NULL, 79.28, 'CMG 24 ga metallic'),
  (24, 'Coated Metals%', '{low_gloss}', NULL, 79.28, 'CMG 24 ga ultra low gloss'),
  (24, 'Coated Metals%', '{premium}', NULL, 110.42, 'CMG 24 ga woodgrain'),
  (24, 'Coated Metals%', NULL, '{Western Rust}', 97.68, 'CMG 24 ga Western Rust'),
  (24, 'Coated Metals%', NULL, '{Rustic Rawhide}', 100.03, 'CMG 24 ga Rustic Rawhide'),
  (24, 'Coated Metals%', NULL, '{Black Ore}', 116.55, 'CMG 24 ga Black Ore'),
  (24, 'Coated Metals%', NULL, '{Vintage}', 112.31, 'CMG 24 ga Vintage'),
  (24, 'Coated Metals%', '{unpainted}', NULL, 58.99, 'CMG 24 ga Galvalume'),
  (26, 'Coated Metals%', '{smooth,pvdf_heat_reflective}', NULL, 57.57, 'CMG 26 ga SMP standard'),
  (26, 'Coated Metals%', '{metallic}', NULL, 60.40, 'CMG 26 ga metallic'),
  (26, 'Coated Metals%', '{textured}', NULL, 60.40, 'CMG 26 ga 3D textured'),
  (26, 'Coated Metals%', '{unpainted}', NULL, 49.55, 'CMG 26 ga Galvalume'),
  (28, 'Coated Metals%', '{smooth,pvdf_heat_reflective}', NULL, 49.73, 'CMG 28 ga SMP standard'),
  -- Any other supplier: the higher cost of the two sheets
  (22, NULL, '{smooth,pvdf_heat_reflective}', NULL, 94.37, 'Higher of CMG / Sheffield'),
  (24, NULL, '{smooth,pvdf_heat_reflective}', NULL, 78.80, 'Higher of CMG / Sheffield'),
  (24, NULL, '{metallic,textured,low_gloss}', NULL, 82.80, 'Higher of CMG / Sheffield'),
  (24, NULL, '{premium}', NULL, 110.42, 'Higher of CMG / Sheffield'),
  (24, NULL, '{unpainted}', NULL, 58.99, 'Higher of CMG / Sheffield'),
  (26, NULL, '{smooth,pvdf_heat_reflective}', NULL, 57.57, 'Higher of CMG / Sheffield'),
  (26, NULL, '{metallic,textured,low_gloss}', NULL, 60.40, 'Higher of CMG / Sheffield'),
  (26, NULL, '{unpainted}', NULL, 49.55, 'Higher of CMG / Sheffield'),
  (28, NULL, '{smooth,pvdf_heat_reflective}', NULL, 49.73, 'CMG 28 ga')
) v
WHERE NOT EXISTS (SELECT 1 FROM flat_sheet_costs);

-- Each color's flat sheet cost and price in each gauge: a rule naming the color beats one for
-- its finish, and one for its own supplier beats the any-supplier one.
CREATE OR REPLACE VIEW v_flat_sheet_prices AS
SELECT DISTINCT ON (c.color_id, r.gauge)
       c.color_id, r.gauge, r.cost, (ceil(r.cost / 0.65 * 100) / 100)::numeric(10,2) AS price, r.note
FROM colors c
LEFT JOIN suppliers s USING (supplier_id)
JOIN flat_sheet_costs r
  ON (r.supplier_like IS NULL OR s.name ILIKE r.supplier_like)
 AND (c.finish = ANY (r.finishes) OR lower(c.name) = ANY (SELECT lower(n) FROM unnest(r.color_names) n))
ORDER BY c.color_id, r.gauge,
         (r.color_names IS NOT NULL AND lower(c.name) = ANY (SELECT lower(n) FROM unnest(r.color_names) n)) DESC,
         (r.supplier_like IS NOT NULL) DESC, r.cost DESC;

-- One flat sheet item per gauge; its list price is the standard color's. The old gauge-less
-- "Flat Sheet" item leaves new quotes (old ones keep it).
WITH added AS (
  INSERT INTO products (sku, name, category, pricing_unit, gauge_id, taxable, price_varies, qbo_item_name)
  SELECT 'FLAT-SHEET-' || g.gauge, 'Flat Sheet ' || g.gauge || ' GA (4'' x 10'')', 'flat_sheet', 'each', g.gauge_id, true, false,
         'Flat Sheet ' || g.gauge || ' GA'
  FROM gauges g
  WHERE g.gauge IN (22, 24, 26, 28)
    AND NOT EXISTS (SELECT 1 FROM products p WHERE p.sku = 'FLAT-SHEET-' || g.gauge)
  RETURNING product_id, gauge_id
)
INSERT INTO product_prices (product_id, unit_price, effective_from, source)
SELECT a.product_id, ceil(r.cost / 0.65 * 100) / 100, current_date, 'Supplier sheets 11/2026, 35% margin (standard color)'
FROM added a JOIN gauges g USING (gauge_id)
JOIN flat_sheet_costs r ON r.gauge = g.gauge AND r.supplier_like IS NULL AND 'smooth' = ANY (r.finishes);

UPDATE products SET active = false WHERE sku = 'FLAT-FLAT-SHEET';
