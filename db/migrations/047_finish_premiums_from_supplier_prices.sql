-- Tyler, 2026-11-11: color premiums by finish from the CMG (8/17/2026) and Sheffield
-- (10/1/2026) coil prices. Each is the supplier's extra coil cost over its standard
-- color, rounded up to a whole percent, plus 2 points for HP:
--   Textured   CMG 3D 26 ga +5.2%, Sheffield TLG +5.3%           -> 8%
--   Low gloss  CMG ULG 24 ga +3.8%, Sheffield +5.3%              -> 8%
--   Metallic   CMG 26 ga +8.9% (24 ga +3.8%), Sheffield +5.3%    -> 11%
--   Premium    CMG woodgrain +46.7%                              -> 49%
--     own colors: Western Rust +29.1% -> 32%, Rustic Rawhide and Vintage +49.5% -> 52%,
--     Black Ore +54.9% -> 57%, Sheffield Cor-Ten AZP (weathered) +29.5% -> 32%
--   Smooth 0%, except Sheffield's premium colors (+4.5% at 26 ga) -> 7%
--   Unpainted 0% (bare coil costs less than painted, so HP keeps the difference)
-- Runs once: the CRM records applied migrations, so later edits on the Colors page stay.
UPDATE color_finishes f SET premium_pct = v.pct
FROM (VALUES ('smooth', 0), ('textured', 8), ('low_gloss', 8), ('metallic', 11), ('premium', 49), ('unpainted', 0))
  AS v(finish, pct)
WHERE f.finish = v.finish;

UPDATE colors c SET upcharge_pct = f.premium_pct
FROM color_finishes f
WHERE c.finish = f.finish AND f.premium_pct IS NOT NULL;

UPDATE colors c SET upcharge_pct = v.pct
FROM (VALUES
    ('Coated Metals Group (CMG)', 'premium', 'Western Rust', 32),
    ('Coated Metals Group (CMG)', 'premium', 'Rustic Rawhide', 52),
    ('Coated Metals Group (CMG)', 'premium', 'Vintage', 52),
    ('Coated Metals Group (CMG)', 'premium', 'Black Ore', 57),
    ('Sheffield Metals', 'premium', 'Cor-Ten AZP Raw', 32),
    ('Sheffield Metals', 'smooth', 'Burgundy', 7),
    ('Sheffield Metals', 'smooth', 'Hartford Green', 7),
    ('Sheffield Metals', 'smooth', 'Hemlock Green', 7),
    ('Sheffield Metals', 'smooth', 'Regal Blue', 7),
    ('Sheffield Metals', 'smooth', 'Regal Red', 7)
  ) AS v(supplier, finish, name, pct)
JOIN suppliers s ON s.name = v.supplier
WHERE c.supplier_id = s.supplier_id AND c.finish = v.finish AND c.name = v.name;
