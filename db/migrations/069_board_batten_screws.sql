-- Tyler, 2026-11-24: Board & Batten screws, figured like the other panels. 1" Panhead
-- Screws (no color), chosen on each panel line: every 6" of panel length (best for
-- Wyoming, the usual), every 12", or every 18" (not suggested). Most B&B goes on wood.
INSERT INTO screw_rules (profile_id, framing, product_id, basis, qty, spacing_in, color_match, is_default, sort_order, option_label)
SELECT pp.profile_id, 'any', p.product_id, 'spacing', 1, x.spacing, false, x.usual, x.sort, x.label
FROM panel_profiles pp
CROSS JOIN products p
CROSS JOIN (VALUES (6, true, 1, 'every 6"'), (12, false, 2, 'every 12"'), (18, false, 3, 'every 18" (not suggested)'))
  AS x (spacing, usual, sort, label)
WHERE pp.name ILIKE 'board%batten%' AND p.sku = 'SCR-PANHEAD-1'
  AND NOT EXISTS (SELECT 1 FROM screw_rules r WHERE r.profile_id = pp.profile_id);

-- Quotes to figure again with today's screw rules (done by the app once it starts, then
-- cleared): every open quote with Board & Batten lines and automatic screws on.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refigure_screws boolean NOT NULL DEFAULT false;
UPDATE orders o SET refigure_screws = true
WHERE o.status = 'quote' AND o.auto_screws
  AND EXISTS (SELECT 1 FROM order_items oi JOIN products p USING (product_id) JOIN panel_profiles pp USING (profile_id)
              WHERE oi.order_id = o.order_id AND pp.name ILIKE 'board%batten%');
