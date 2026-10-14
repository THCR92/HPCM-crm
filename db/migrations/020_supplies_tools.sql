-- Supplies (boots, jacks, screws, accessories) counted on hand, and shop tools,
-- some of which are rented out on quotes and checked out and back in.

-- Supplies ------------------------------------------------------------------
-- track_stock: count this product on the Supplies page. stock_by_color: count
-- each color separately (screws come in the panel colors).
ALTER TABLE products
    ADD COLUMN track_stock    boolean NOT NULL DEFAULT false,
    ADD COLUMN stock_by_color boolean NOT NULL DEFAULT false,
    ADD COLUMN is_rental      boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN products.is_rental IS 'Tool rental: quantity on a quote is the number of days';
UPDATE products SET track_stock = true WHERE category IN ('boot', 'jack', 'fastener', 'accessory');
UPDATE products SET stock_by_color = true WHERE category = 'fastener';

-- One row per product (and color, for products counted by color). Quantities
-- are in the unit the product is sold in (each, bag, roll ...).
CREATE TABLE supply_stock (
    supply_id    serial        PRIMARY KEY,
    product_id   int           NOT NULL REFERENCES products,
    color_id     int           REFERENCES colors,
    qty_on_hand  numeric(12,2) NOT NULL DEFAULT 0,          -- can go below zero if more was sold than counted
    reorder_at   numeric(12,2) CHECK (reorder_at >= 0),     -- flag it when what's left drops to this
    location     text,
    updated_at   timestamptz   NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (product_id, color_id)
);

CREATE TABLE supply_transactions (
    supply_txn_id bigserial    PRIMARY KEY,
    supply_id     int          NOT NULL REFERENCES supply_stock ON DELETE CASCADE,
    txn_type      text         NOT NULL CHECK (txn_type IN ('receive', 'order', 'count', 'adjust')),
    qty_delta     numeric(12,2) NOT NULL,
    order_id      bigint       REFERENCES orders ON DELETE SET NULL,  -- 'order': taken out when the order was completed
    performed_by  text,
    note          text,
    occurred_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX supply_txn_supply_idx ON supply_transactions (supply_id, occurred_at);
CREATE INDEX supply_txn_order_idx ON supply_transactions (order_id) WHERE order_id IS NOT NULL;

CREATE FUNCTION fn_apply_supply_txn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE supply_stock SET qty_on_hand = qty_on_hand + NEW.qty_delta, updated_at = now()
     WHERE supply_id = NEW.supply_id;
    RETURN NEW;
END $$;
CREATE TRIGGER supply_txn_apply AFTER INSERT ON supply_transactions
    FOR EACH ROW EXECUTE FUNCTION fn_apply_supply_txn();

-- A starting row for each item not counted by color.
INSERT INTO supply_stock (product_id)
SELECT product_id FROM products WHERE track_stock AND NOT stock_by_color;

-- Tools -----------------------------------------------------------------------
-- Every tool the shop owns. rental_product_id is the price list item it's
-- rented as ("Hand seamer rental (per day)"); NULL = a shop tool, not rented.
CREATE TABLE tools (
    tool_id            serial      PRIMARY KEY,
    name               text        NOT NULL,
    tag                text        UNIQUE,                     -- number written on the tool
    serial_number      text,
    rental_product_id  int         REFERENCES products,
    status             text        NOT NULL DEFAULT 'available'
                       CHECK (status IN ('available', 'repair', 'retired')),  -- "out" comes from tool_rentals
    location           text,
    purchase_cost      numeric(12,2) CHECK (purchase_cost >= 0),
    purchased_on       date,
    notes              text,
    created_at         timestamptz NOT NULL DEFAULT now()
);

-- One row each time a tool leaves with a customer.
CREATE TABLE tool_rentals (
    rental_id      serial      PRIMARY KEY,
    tool_id        int         NOT NULL REFERENCES tools,
    order_id       bigint      NOT NULL REFERENCES orders ON DELETE CASCADE,
    order_item_id  bigint      REFERENCES order_items ON DELETE SET NULL,
    out_at         timestamptz NOT NULL DEFAULT now(),
    out_by         text,
    due_back       date,
    returned_at    timestamptz,
    returned_by    text,
    return_note    text,
    CHECK (returned_at IS NULL OR returned_at >= out_at)
);
CREATE UNIQUE INDEX tool_rentals_one_out ON tool_rentals (tool_id) WHERE returned_at IS NULL;
CREATE INDEX tool_rentals_order_idx ON tool_rentals (order_id);
