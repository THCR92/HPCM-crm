-- Tyler, 2026-11-24: Sheffield's woodgrain (WoodCraft) colors come only in 24 ga too, so
-- Sheffield colors in the Premium (woodgrain) finish are stocked in 24 ga only, like CMG's.
WITH shf AS (
  SELECT c.color_id FROM colors c JOIN suppliers s USING (supplier_id)
  WHERE s.name ILIKE 'sheffield%' AND (c.finish = 'premium' OR c.name ~* 'wood')
), gone AS (
  DELETE FROM color_gauges cg USING shf, gauges g
  WHERE cg.color_id = shf.color_id AND g.gauge_id = cg.gauge_id AND g.gauge <> 24
)
INSERT INTO color_gauges (color_id, gauge_id)
SELECT shf.color_id, g.gauge_id FROM shf CROSS JOIN gauges g
WHERE g.gauge = 24
  AND NOT EXISTS (SELECT 1 FROM color_gauges x WHERE x.color_id = shf.color_id AND x.gauge_id = g.gauge_id);
