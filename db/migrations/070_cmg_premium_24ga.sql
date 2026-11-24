-- Tyler, 2026-11-24: CMG's woodgrain colors come only in 24 ga steel (48" master coils),
-- and so do Western Rust, Rustic Rawhide, Black Ore and Vintage. They're offered only on
-- 24 ga panels and trim (a line with no gauge counts as 26 ga, so it won't offer them).
-- A line that already has one of these colors in another gauge keeps it, marked as not stocked.
WITH cmg AS (
  SELECT c.color_id FROM colors c JOIN suppliers s USING (supplier_id)
  WHERE s.name ILIKE 'coated metals group%'
    AND (c.finish = 'premium' OR c.name ~* '^(western rust|rustic rawhide|black ore|vintage)$')
), gone AS (
  DELETE FROM color_gauges cg USING cmg, gauges g
  WHERE cg.color_id = cmg.color_id AND g.gauge_id = cg.gauge_id AND g.gauge <> 24
)
INSERT INTO color_gauges (color_id, gauge_id)
SELECT cmg.color_id, g.gauge_id FROM cmg CROSS JOIN gauges g
WHERE g.gauge = 24
  AND NOT EXISTS (SELECT 1 FROM color_gauges x WHERE x.color_id = cmg.color_id AND x.gauge_id = g.gauge_id);
