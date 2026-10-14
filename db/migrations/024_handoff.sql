-- Pickup and delivery: scanning the whole-order label when it leaves the shop
-- marks it picked up or delivered, with who handed it off and who took it.
ALTER TABLE orders
    ADD COLUMN handed_off_at timestamptz,
    ADD COLUMN handed_off_by text,
    ADD COLUMN handoff_method text CHECK (handoff_method IN ('pickup', 'delivery')),
    ADD COLUMN received_by   text,
    ADD COLUMN handoff_note  text;
