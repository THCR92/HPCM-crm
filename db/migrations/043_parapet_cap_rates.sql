-- Tyler, 2026-11-05: Parapet Cap 24 GA is $4.40 per inch of flat width per piece; the 26 ga
-- parapet cap (and the plain "Parapet Cap", which is 26 ga) stays $3.40. Trim can now be given
-- its own per-inch price on the product form.
UPDATE products SET price_per_flat_in = 4.40
WHERE category = 'trim' AND name ~* 'parapet'
  AND (gauge_id = (SELECT gauge_id FROM gauges WHERE gauge = 24) OR (gauge_id IS NULL AND name ~* '\m24\s*ga'));

UPDATE products SET price_per_flat_in = 3.40
WHERE category = 'trim' AND name ~* 'parapet' AND price_per_flat_in IS DISTINCT FROM 4.40
  AND (gauge_id IS NULL OR gauge_id = (SELECT gauge_id FROM gauges WHERE gauge = 26));
