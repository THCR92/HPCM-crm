-- Lines someone added by hand to the automatic Screws or Closures section (kept on every
-- save, unlike the figured lines), and in-house changes to how many closures a quote gets.
ALTER TABLE order_items ADD COLUMN is_added boolean NOT NULL DEFAULT false;
-- {"<closure product id>": pieces}: replaces the figured count for that closure.
ALTER TABLE orders ADD COLUMN closure_qty jsonb;
