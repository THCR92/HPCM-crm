-- When an order was marked Ready, so the shop board can show how long it has waited.
ALTER TABLE orders ADD COLUMN ready_at timestamptz;
UPDATE orders SET ready_at = updated_at WHERE status = 'ready';
