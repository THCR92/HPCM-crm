-- Tyler, 2026-10-21: 26 ga ridge cap is $3.40 per flat inch at the standard width too,
-- so the standard 14" flat (13" finished) piece is $47.60, not $44.20. The price list
-- follows; quotes already written keep the price they were given.
INSERT INTO product_prices (product_id, unit_price, effective_from, source)
SELECT p.product_id, round(p.price_per_flat_in * p.girth_in, 2), current_date, 'Tyler 2026-10-21: $3.40 x 14" flat'
FROM products p
JOIN v_current_prices cp USING (product_id)
WHERE p.price_per_flat_in IS NOT NULL AND p.girth_in IS NOT NULL
  AND cp.unit_price <> round(p.price_per_flat_in * p.girth_in, 2)
ON CONFLICT (product_id, effective_from) DO UPDATE SET unit_price = EXCLUDED.unit_price, source = EXCLUDED.source;
