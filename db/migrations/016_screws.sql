-- Screws figured automatically on quotes and orders.
--
-- A screw rule says which screw goes with a kind of panel (through-fastened or
-- concealed) on a kind of framing (wood or steel) at a length, and how many per
-- square (100 sq ft). Through-fastener panels (PBR, Tuff Rib) on wood framing use
-- #10 woodgrip screws with a rubber washer, 90 per square, color matched to the
-- panel; 1.5" is standard and 2" is offered when needed (Tyler, 2026-10-12).
-- Screws are sold by the bag (products.pack_size screws per bag).

CREATE TABLE screw_rules (
    screw_rule_id   serial PRIMARY KEY,
    fastening       panel_fastening NOT NULL,
    framing         text NOT NULL CHECK (framing IN ('wood', 'steel')),
    length_label    text NOT NULL,
    product_id      int NOT NULL REFERENCES products,
    per_square      numeric(8,2) NOT NULL CHECK (per_square > 0),
    is_default      boolean NOT NULL DEFAULT false,
    sort_order      int NOT NULL DEFAULT 0,
    UNIQUE (fastening, framing, length_label)
);

-- Bag counts aren't on the price list yet; 250 is the usual bag.
UPDATE products SET pack_size = 250 WHERE sku = 'SCR-10-1-5-WOODTITE-SCREWS' AND pack_size IS NULL;
UPDATE products SET name = '#10 1.5" Woodgrip Screws' WHERE sku = 'SCR-10-1-5-WOODTITE-SCREWS' AND name = '#10 1.5 Woodtite Screws';
INSERT INTO products (sku, name, category, pricing_unit, pack_size, price_varies, taxable)
VALUES ('SCR-10-2-WOODGRIP', '#10 2" Woodgrip Screws', 'fastener', 'bag', 250, false, true)
ON CONFLICT (sku) DO NOTHING;

INSERT INTO screw_rules (fastening, framing, length_label, product_id, per_square, is_default, sort_order)
SELECT 'through_fastened', 'wood', v.len, p.product_id, 90, v.def, v.ord
FROM (VALUES ('SCR-10-1-5-WOODTITE-SCREWS', '1.5"', true, 1), ('SCR-10-2-WOODGRIP', '2"', false, 2)) v(sku, len, def, ord)
JOIN products p ON p.sku = v.sku;

-- Orders: whether to figure screws, the building's framing and the screw length.
-- Orders written before this keep their lines as they are.
ALTER TABLE orders
    ADD COLUMN auto_screws boolean NOT NULL DEFAULT false,
    ADD COLUMN framing text NOT NULL DEFAULT 'wood' CHECK (framing IN ('wood', 'steel')),
    ADD COLUMN screw_length text;
ALTER TABLE orders ALTER COLUMN auto_screws SET DEFAULT true;

-- The section the app fills in by itself.
ALTER TABLE order_sections ADD COLUMN is_auto boolean NOT NULL DEFAULT false;
