-- Screw rules for trim and accessories, not just panels (Tyler, 2026-10-13).
--
-- A rule now belongs to a panel profile (as before) or to a product (ridge cap,
-- gable trim...). Product rules:
--   * say which panels they go with: through-fastener, standing seam, or any;
--     the quote picks which screws trim gets (it starts from the panels on it);
--   * can leave the screw blank to mean "the same screw as the panels", which
--     follows the quote's framing and length (wood 1.5" Woodtite, steel self drilling);
--   * count per piece: every N inches of the piece, or a set number each;
--   * can offer choices on the line (ridge cap every 18" or every 9").
-- Trim screws match the trim's color and are their own lines.

ALTER TABLE screw_rules
    ALTER COLUMN profile_id DROP NOT NULL,
    ALTER COLUMN product_id DROP NOT NULL,
    ADD COLUMN item_product_id int REFERENCES products ON DELETE CASCADE,
    ADD COLUMN panel_system text NOT NULL DEFAULT 'any' CHECK (panel_system IN ('through_fastened', 'concealed', 'any')),
    ADD COLUMN option_label text,
    ADD CONSTRAINT screw_rules_for_one CHECK ((profile_id IS NULL) <> (item_product_id IS NULL)),
    ADD CONSTRAINT screw_rules_panel_screw CHECK (product_id IS NOT NULL OR item_product_id IS NOT NULL);
ALTER TABLE screw_rules DROP CONSTRAINT screw_rules_basis_check;
ALTER TABLE screw_rules ADD CONSTRAINT screw_rules_basis_check CHECK (basis IN ('square', 'spacing', 'each'));
DROP INDEX screw_rules_unique;
CREATE UNIQUE INDEX screw_rules_unique ON screw_rules
    (COALESCE(profile_id, 0), COALESCE(item_product_id, 0), framing, panel_system,
     COALESCE(length_label, ''), COALESCE(option_label, ''), COALESCE(product_id, 0));

INSERT INTO screw_rules (item_product_id, panel_system, framing, product_id, basis, qty, spacing_in,
                         color_match, option_label, is_default, sort_order)
SELECT p.product_id, 'through_fastened', 'any', NULL, 'spacing', 2, v.spacing, true, v.opt, v.def, v.ord
FROM (VALUES
    ('TRM-RIDGE-24', 18, 'every 18"', true, 1), ('TRM-RIDGE-24', 9, 'every 9"', false, 2),
    ('TRM-RIDGE-26', 18, 'every 18"', true, 1), ('TRM-RIDGE-26', 9, 'every 9"', false, 2),
    ('TRM-GBL-2X4', 24, NULL, false, 1), ('TRM-GABLE-2X6', 24, NULL, false, 1)
) v(sku, spacing, opt, def, ord)
JOIN products p ON p.sku = v.sku;

-- Which screws the quote's trim gets ('through_fastened', 'concealed' or 'none');
-- empty means "from the panels on the quote".
ALTER TABLE orders ADD COLUMN trim_screws_for text CHECK (trim_screws_for IN ('through_fastened', 'concealed', 'none'));
-- The choice made on a line, e.g. 'every 9"'.
ALTER TABLE order_items ADD COLUMN screw_option text;

-- Managers can edit screw rules too.
UPDATE users SET permissions = array_append(permissions, 'screws')
WHERE role IN ('admin', 'manager') AND NOT 'screws' = ANY (permissions);
