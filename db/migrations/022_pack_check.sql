-- Pack and check: each line's label is scanned when its bundle is checked
-- against the order and packed. Editing the order clears the checks.
ALTER TABLE order_items
    ADD COLUMN packed_at timestamptz,
    ADD COLUMN packed_by text;
