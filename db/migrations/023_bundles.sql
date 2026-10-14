-- Bundles: a line is packed in bundles (26 pieces of drip edge = 10 + 10 + 6),
-- each with its own label to scan in pack and check.
ALTER TABLE products ADD COLUMN bundle_size int CHECK (bundle_size > 0);
COMMENT ON COLUMN products.bundle_size IS 'Pieces per bundle when packing; NULL = the whole line is one bundle';
-- Standard drip edge goes in bundles of 10 (Tyler, 2026-10-14).
UPDATE products SET bundle_size = 10 WHERE sku IN ('TRM-2X2X120', 'TRM-2X4X120', 'TRM-D-STYLE-90');

CREATE TABLE order_bundles (
    bundle_id      bigserial     PRIMARY KEY,
    order_item_id  bigint        NOT NULL REFERENCES order_items ON DELETE CASCADE,
    seq            smallint      NOT NULL,
    pieces         numeric(10,2) NOT NULL CHECK (pieces > 0),
    packed_at      timestamptz,
    packed_by      text,
    UNIQUE (order_item_id, seq)
);

-- Lines checked before bundles existed become one checked bundle.
INSERT INTO order_bundles (order_item_id, seq, pieces, packed_at, packed_by)
SELECT order_item_id, 1, pieces, packed_at, packed_by FROM order_items WHERE packed_at IS NOT NULL;
