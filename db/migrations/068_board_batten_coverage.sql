-- Tyler, 2026-11-24: Board & Batten (New Tech BB750) runs 10" to 24" coverage, each panel
-- taking its coverage + 3-5/8" of coil. It's priced per sq ft of COIL now (one number per
-- gauge), and a line's price per sq ft covered follows its coverage:
--   price per covered sq ft = coil price x (coverage + 3.625) / coverage.
-- The coil price is today's price at 13.5" coverage x 13.5 / 17.125, so 13.5" panels keep
-- exactly the price they have ($4.75 24 GA, $3.75 26 GA). Quotes already written keep theirs.
ALTER TABLE panel_profiles ADD COLUMN IF NOT EXISTS coil_extra_in numeric(6,3) CHECK (coil_extra_in >= 0);

UPDATE panel_profiles SET min_coverage_in = 10, max_coverage_in = 24, coil_extra_in = 3.625
WHERE name ILIKE 'board%batten%';

INSERT INTO product_prices (product_id, unit_price, effective_from, source)
SELECT p.product_id, round(cp.unit_price * pp.coverage_width_in / (pp.coverage_width_in + pp.coil_extra_in), 4),
       current_date, 'Per sq ft of coil (Tyler 2026-11-24)'
FROM products p JOIN panel_profiles pp USING (profile_id) JOIN v_current_prices cp USING (product_id)
WHERE pp.coil_extra_in > 0 AND p.pricing_unit = 'sqft'
ON CONFLICT (product_id, effective_from) DO UPDATE SET unit_price = EXCLUDED.unit_price, source = EXCLUDED.source;
