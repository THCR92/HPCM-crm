-- Tyler, 2026-11-11: every accessory on the CMG (8/17/2026) and Sheffield (10/1/2026)
-- price sheets is on the price list at a 35% margin: price = cost / 0.65, rounded up to the
-- cent. Cost is per selling unit (a clip from a box, a tube from a case). Where both
-- suppliers sell the item, the higher cost is used, so the margin holds from either one.

-- Items already on the list: raised to a 35% margin where they're below it. Items priced
-- above it keep their price (Tyler decides on those).
INSERT INTO product_prices (product_id, unit_price, effective_from, source)
SELECT p.product_id, ceil(v.cost / 0.65 * 100) / 100, current_date, 'Supplier sheets 11/2026, 35% margin'
FROM (VALUES
    ('SCR-10-1-5-WOODTITE-SCREWS', 32.50),   -- CMG 1.5" painted Woodgrip (Sheffield Panel-Tite 1.5" $24.38)
    ('SCR-2-1-2IN-WOODTITE-SCREW-1', 29.17), -- Sheffield Panel-Tite #10-12 x 2.5"
    ('SCR-PANHEAD-1', 13.54),                -- Sheffield 1" low profile pancake (CMG $12.50)
    ('ACC-RIVETS', 30.00),                   -- CMG #43 painted rivets, bag of 250
    ('ACC-BUTYL', 6.28),                     -- Sheffield butyl tape, per 40' roll
    ('ACC-CLIP-15', 0.2462),                 -- Sheffield 1.5" 450 SnapLock 3-hole, $147.69 / 600
    ('ACC-S5-SNOWBAR', 33.29),               -- ColorGard Sno-Rail 8'
    ('ACC-S5U-SNOWBAR-CLAMPS', 8.40),        -- S-5 U-Clamp
    ('ACC-S5U-VERSA-CLIPS', 1.63),           -- S-5 VersaClip
    ('BOOT-3-HI-TEMP-PIPE-BOOT', 23.55),     -- High Temp 3 1/4"-4"
    ('BOOT-5-HI-TEMP-PIPE-BOOT', 36.14)      -- High Temp 5 4"-7"
  ) AS v(sku, cost)
JOIN products p ON p.sku = v.sku
LEFT JOIN v_current_prices cp ON cp.product_id = p.product_id
WHERE cp.unit_price IS NULL OR cp.unit_price < ceil(v.cost / 0.65 * 100) / 100
ON CONFLICT (product_id, effective_from) DO UPDATE SET unit_price = EXCLUDED.unit_price, source = EXCLUDED.source;

-- Items not on the list yet. Skipped if an item with the same name is already there.
CREATE TEMP TABLE new_acc (sku text, name text, category product_category, unit pricing_unit,
  pack integer, by_color boolean, cost numeric) ON COMMIT DROP;
INSERT INTO new_acc VALUES
  -- Snap lock clips (each; box quantity in the name)
  ('ACC-CLIP-SL450-2H', '1.5" SnapLock 450 Clip 24 ga, 2-hole (box of 800)', 'accessory', 'each', NULL, false, 123.08 / 800),
  ('ACC-CLIP-SL450-3H', '1.5" SnapLock 450 Clip 24 ga, 3-hole (box of 600)', 'accessory', 'each', NULL, false, 147.69 / 600),
  ('ACC-CLIP-SL550-20', '1.5" SnapLock 550 Clip 20 ga (box of 500)', 'accessory', 'each', NULL, false, 205.38 / 500),
  ('ACC-CLIP-SL675-18', '1.75" SnapLock 675 Clip 18 ga (box of 400)', 'accessory', 'each', NULL, false, 104.62 / 400),
  ('ACC-CLIP-SL675-18L', '1.75" SnapLock 675 Clip 18 ga, 3.5" long (box of 250)', 'accessory', 'each', NULL, false, 164.82 / 250),
  -- Mechanical seam clips
  ('ACC-CLIP-MF1-26', '1" Mechanical Fixed Clip 26 ga (box of 1000)', 'accessory', 'each', NULL, false, 123.08 / 1000),
  ('ACC-CLIP-MF15-24', '1.5" Mechanical Fixed Clip 24 ga (box of 1000)', 'accessory', 'each', NULL, false, 138.46 / 1000),
  ('ACC-CLIP-BF15-BASE', '1.5" Mechanical Seam Butterfly Clip Base 22 ga (box of 200)', 'accessory', 'each', NULL, false, 125.75 / 200),
  ('ACC-CLIP-BF15-TAB', '1.5" Mechanical Seam Butterfly Clip Tab 24 ga (box of 200)', 'accessory', 'each', NULL, false, 77.23 / 200),
  ('ACC-CLIP-MF2-24', '2" Mechanical Fixed Clip 24 ga (box of 300)', 'accessory', 'each', NULL, false, 92.31 / 300),
  ('ACC-CLIP-FLOAT2', '2" Mechanical Open Framing Float Clip, 16 ga base / 22 ga tab (box of 100)', 'accessory', 'each', NULL, false, 129.51 / 100),
  ('ACC-CLIP-BF2-BASE', '2" Mechanical Seam Butterfly Clip Base 18 ga (box of 150)', 'accessory', 'each', NULL, false, 141.00 / 150),
  ('ACC-CLIP-BF2-TAB', '2" Mechanical Seam Butterfly Clip Tab 22 ga (box of 150)', 'accessory', 'each', NULL, false, 63.35 / 150),
  -- Screws (bags of 250)
  ('SCR-PANELTITE-2', '#10-12 x 2" Panel-Tite Screws', 'fastener', 'bag', 250, true, 26.21),
  ('SCR-PANELTITE-075', '#12 x 3/4" Panel-Tite Screws', 'fastener', 'bag', 250, true, 24.53),
  ('SCR-ULP-1-18', '#10-9 x 1-1/8" ULP Clip Screws (into wood)', 'fastener', 'bag', 250, false, 13.54),
  ('SCR-DP3-1', '#10-16 x 1" DP3 Clip Screws (into metal)', 'fastener', 'bag', 250, false, 21.65),
  ('SCR-DP1-15', '#14-13 x 1.5" DP1 Clip Screws (into metal)', 'fastener', 'bag', 250, false, 43.18),
  ('ACC-RIVETS-SS', '#43 Stainless Steel Pop Rivets', 'accessory', 'bag', 250, false, 20.49),
  -- Pipe boots
  ('BOOT-DEKTITE-1', 'DekTite #1 Pipe Boot (1/4" - 2")', 'boot', 'each', NULL, false, 7.29),
  ('BOOT-DEKTITE-2', 'DekTite #2 Pipe Boot (1-3/4" - 3-1/4")', 'boot', 'each', NULL, false, 7.92),
  ('BOOT-DEKTITE-3', 'DekTite #3 Pipe Boot (1/4" - 4")', 'boot', 'each', NULL, false, 8.18),
  ('BOOT-DEKTITE-4', 'DekTite #4 Pipe Boot (3" - 6")', 'boot', 'each', NULL, false, 13.92),
  ('BOOT-DEKTITE-5', 'DekTite #5 Pipe Boot (4" - 7")', 'boot', 'each', NULL, false, 14.40),
  ('BOOT-DEKTITE-6', 'DekTite #6 Pipe Boot (5" - 9")', 'boot', 'each', NULL, false, 17.03),
  ('BOOT-DEKTITE-7', 'DekTite #7 Pipe Boot (6" - 11")', 'boot', 'each', NULL, false, 23.80),
  ('BOOT-DEKTITE-8', 'DekTite #8 Pipe Boot (8" - 13")', 'boot', 'each', NULL, false, 30.71),
  ('BOOT-DEKTITE-9', 'DekTite #9 Pipe Boot (10" - 18")', 'boot', 'each', NULL, false, 48.78),
  ('BOOT-RETRO-1', 'Retrofit Pipe Boot #1 (1-3/4" - 2-3/4")', 'boot', 'each', NULL, false, 19.31),
  ('BOOT-RETRO-2', 'Retrofit Pipe Boot #2 (2" - 7-1/4")', 'boot', 'each', NULL, false, 26.60),
  ('BOOT-RETRO-3', 'Retrofit Pipe Boot #3 (3-1/4" - 10")', 'boot', 'each', NULL, false, 51.80),
  ('BOOT-HT-8', '#8 Hi-Temp Pipe Boot (8" - 13")', 'boot', 'each', NULL, false, 94.12),
  -- Sealant and paint
  ('ACC-NOVAFLEX', 'NovaFlex Sealant (tube)', 'accessory', 'each', NULL, true, 14.05),
  ('ACC-PAINT-PEN', 'Color Matched Paint Pen', 'accessory', 'each', NULL, true, 24.16),
  ('ACC-SPRAY-PAINT', 'Color Matched Spray Paint', 'accessory', 'each', NULL, true, 47.31),
  -- Underlayment (per roll)
  ('ACC-UL-FT-BUTYL', 'FT Synthetics High-Temp Butyl Underlayment (2 sq roll)', 'accessory', 'roll', NULL, false, 125.00),
  ('ACC-UL-RESISTO', 'Resisto Soprema High Temp Fire Rated Class A Underlayment (2 sq roll)', 'accessory', 'roll', NULL, false, 130.00),
  ('ACC-UL-SHARK-COMP', 'Sharkskin Comp Underlayment (48" x 250'')', 'accessory', 'roll', NULL, false, 200.64),
  ('ACC-UL-SHARK-ULTRA-SA', 'Sharkskin Ultra SA Underlayment (48" x 125'')', 'accessory', 'roll', NULL, false, 362.06),
  ('ACC-UL-SHARK-SA-MINI', 'Sharkskin Ultra SA Mini (8" x 125'')', 'accessory', 'roll', NULL, false, 71.21),
  ('ACC-UL-SHARK-ULTRA', 'Sharkskin Ultra Underlayment (48" x 250'')', 'accessory', 'roll', NULL, false, 367.84),
  ('ACC-UL-SHARK-VENT', 'Sharkskin Ventilated Mat (48" x 50'')', 'accessory', 'roll', NULL, false, 169.64),
  ('ACC-UL-CMI-PSMAX', 'CMI PS Max HT 2.0 Underlayment (36" x 66.7'', 2 sq roll)', 'accessory', 'roll', NULL, false, 106.60),
  ('ACC-UL-TITANIUM-FR', 'Titanium FR Underlayment (36" x 50'')', 'accessory', 'roll', NULL, false, 163.33),
  ('ACC-CORAVENT-600TE', 'Cor-A-Vent 600TE (per piece)', 'accessory', 'each', NULL, false, 6.23),
  -- S-5 snow retention (each; sold in boxes)
  ('ACC-S5-E-CLAMP', 'S-5 E-Clamp (box of 50)', 'accessory', 'each', NULL, false, 5.31),
  ('ACC-S5-N-CLAMP', 'S-5 N-Clamp (box of 30)', 'accessory', 'each', NULL, false, 6.37),
  ('ACC-S5-S-CLAMP', 'S-5 S-Clamp (box of 30)', 'accessory', 'each', NULL, false, 6.57),
  ('ACC-S5-V-CLAMP', 'S-5 V-Clamp (box of 30)', 'accessory', 'each', NULL, false, 6.57),
  ('ACC-S5-SNOCLIP2', 'S-5 SnoClip II 2.0 (box of 55)', 'accessory', 'each', NULL, false, 2.59),
  ('ACC-S5-SNOCLIP3', 'S-5 SnoClip III 2.0 (box of 35)', 'accessory', 'each', NULL, false, 3.24);

WITH added AS (
  INSERT INTO products (sku, name, category, pricing_unit, pack_size, taxable, price_varies, track_stock, stock_by_color)
  SELECT n.sku, n.name, n.category, n.unit, n.pack, true, false, true, n.by_color
  FROM new_acc n
  WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.sku = n.sku OR lower(p.name) = lower(n.name))
  RETURNING product_id, sku
)
INSERT INTO product_prices (product_id, unit_price, effective_from, source)
SELECT a.product_id, ceil(n.cost / 0.65 * 100) / 100, current_date, 'Supplier sheets 11/2026, 35% margin'
FROM added a JOIN new_acc n USING (sku);
