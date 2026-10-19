-- Closures on through-fastener panels (Tyler 2026-10-19): every PBR or Tuff Rib panel
-- gets 1 inside and 1 outside closure, figured on the quote like screws. Each quote
-- picks standard closures, vented (vented outside closure at the ridge) or none.

ALTER TABLE panel_profiles
    ADD COLUMN closure_product_id        int REFERENCES products,
    ADD COLUMN vented_closure_product_id int REFERENCES products;

UPDATE panel_profiles pp SET closure_product_id = p.product_id
FROM products p WHERE p.sku = 'ACC-CLOS-IO' AND pp.name = 'Tuff Rib';
UPDATE panel_profiles pp SET closure_product_id = p.product_id
FROM products p WHERE p.sku = 'ACC-PBR-CLOSURE' AND pp.name = 'PBR/R Panel';
UPDATE panel_profiles pp SET vented_closure_product_id = p.product_id
FROM products p WHERE p.sku = 'ACC-VENTED-CLOSURE-THROUGH-F' AND pp.closure_product_id IS NOT NULL;

-- Quotes made before this keep what they have ("none"); new quotes start on "standard".
ALTER TABLE orders
    ADD COLUMN closures text NOT NULL DEFAULT 'none' CHECK (closures IN ('standard', 'vented', 'none')),
    -- "I've added any other accessories they need" (pipe boots, butyl tape, sealant...).
    ADD COLUMN accessories_checked boolean NOT NULL DEFAULT false;
