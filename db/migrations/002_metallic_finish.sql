-- Adds the Metallic finish. Non-smooth finishes show in the color label:
-- "Copper (ABC Metals, metallic)".
ALTER TABLE colors DROP CONSTRAINT colors_finish_check;
ALTER TABLE colors ADD CONSTRAINT colors_finish_check CHECK (finish IN ('smooth', 'textured', 'metallic'));

CREATE OR REPLACE VIEW v_colors AS
SELECT c.*, s.name AS supplier_name,
       c.name || CASE WHEN s.name IS NULL AND c.finish = 'smooth' THEN ''
                      ELSE ' (' || concat_ws(', ', s.name,
                                  CASE WHEN c.finish <> 'smooth' THEN c.finish END) || ')'
                 END AS label
FROM colors c LEFT JOIN suppliers s USING (supplier_id);
