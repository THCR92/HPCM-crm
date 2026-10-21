-- Tyler, 2026-10-21: hide the old combined closure items now that each profile has its own
-- Inner and Outer Closure (migration 037). Old quotes and orders keep their lines.
UPDATE products SET active = false WHERE sku IN ('ACC-PBR-CLOSURE', 'ACC-CLOS-IO');
