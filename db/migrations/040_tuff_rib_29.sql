-- Tyler, 2026-11-05: Tuff Rib Panel 29 GA, with the same rules as the 26 GA one (same profile:
-- coverage, screws, closures). No list price yet: Tyler enters it himself.
INSERT INTO products (sku, name, category, profile_id, gauge_id, pricing_unit, is_cut_to_length, taxable, qbo_item_name)
SELECT 'PNL-TR-29', 'Tuff Rib Panel 29 GA', p.category, p.profile_id, g.gauge_id, p.pricing_unit, p.is_cut_to_length, p.taxable,
       'Tuff Rib Panel 29 GA'
FROM products p, gauges g
WHERE p.sku = 'PNL-TR-26' AND g.gauge = 29
  AND NOT EXISTS (SELECT 1 FROM products WHERE sku = 'PNL-TR-29' OR name = 'Tuff Rib Panel 29 GA');
