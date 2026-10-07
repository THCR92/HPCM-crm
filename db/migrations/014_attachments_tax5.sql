-- Drawings and other files attached to an order or to one of its lines (for
-- example a reMarkable sketch of a custom trim with face lengths and bends).
-- Files live in the database because the host wipes its disk on each deploy.
--
-- Also: Cheyenne sales tax is 5% (no sixth-penny tax right now), so the
-- default drops from 6 to 5 and open quotes still at 6 follow it.

CREATE TABLE order_attachments (
    attachment_id   serial PRIMARY KEY,
    order_id        int NOT NULL REFERENCES orders ON DELETE CASCADE,
    -- If the line is deleted the drawing stays on the order.
    order_item_id   int REFERENCES order_items ON DELETE SET NULL,
    filename        text NOT NULL,
    content_type    text NOT NULL,
    byte_size       int NOT NULL,
    data            bytea NOT NULL,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_attachments_order ON order_attachments (order_id);

UPDATE app_settings SET value = '5', updated_at = now() WHERE key = 'sales_tax_rate' AND value = '6';
UPDATE orders SET tax_rate = 5 WHERE tax_rate = 6 AND status = 'quote';
