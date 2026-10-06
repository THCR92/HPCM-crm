-- Finishes move into their own list so new ones can be added from the Colors
-- page. The same color name can now come from one supplier in several finishes
-- (e.g. CMG's Charcoal in Smooth and in PVDF heat-reflective), so a color is
-- unique by supplier + name + finish.

CREATE TABLE color_finishes (
    finish      text     PRIMARY KEY,           -- stored on colors.finish
    label       text     NOT NULL UNIQUE,       -- shown to people
    sort_order  smallint NOT NULL DEFAULT 100
);
INSERT INTO color_finishes (finish, label, sort_order) VALUES
    ('smooth',               'Smooth',               1),
    ('textured',             'Textured',             2),
    ('metallic',             'Metallic',             3),
    ('premium',              'Premium',              4),
    ('pvdf_heat_reflective', 'PVDF heat-reflective', 5);

ALTER TABLE colors DROP CONSTRAINT colors_finish_check;
ALTER TABLE colors ADD CONSTRAINT colors_finish_fkey
    FOREIGN KEY (finish) REFERENCES color_finishes ON UPDATE CASCADE;

ALTER TABLE colors DROP CONSTRAINT colors_supplier_name_key;
ALTER TABLE colors ADD CONSTRAINT colors_supplier_name_finish_key
    UNIQUE NULLS NOT DISTINCT (supplier_id, name, finish);

-- Label: "Charcoal (CMG)", "Charcoal (CMG, PVDF heat-reflective)".
DROP VIEW v_colors;
CREATE VIEW v_colors AS
SELECT c.*, s.name AS supplier_name, f.label AS finish_label, f.sort_order AS finish_sort,
       c.name || CASE WHEN s.name IS NULL AND c.finish = 'smooth' THEN ''
                      ELSE ' (' || concat_ws(', ', s.name,
                                  CASE WHEN c.finish <> 'smooth' THEN f.label END) || ')'
                 END AS label
FROM colors c
JOIN color_finishes f USING (finish)
LEFT JOIN suppliers s USING (supplier_id);
