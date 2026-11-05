-- Tyler, 2026-11-05: the cut list gets a check box per line for when it's done, with the
-- date and the initials of whoever ticked it. Changing what a line is (item, color, count,
-- length or width) un-ticks it, since the new pieces haven't been made.
ALTER TABLE order_items
    ADD COLUMN done_at timestamptz,
    ADD COLUMN done_by text,        -- initials
    ADD COLUMN done_by_name text;   -- full name, for the tooltip

CREATE FUNCTION fn_order_item_undone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.done_at IS NOT NULL AND NEW.done_at IS NOT DISTINCT FROM OLD.done_at
       AND (NEW.product_id, NEW.color_id, NEW.pieces, NEW.length_in, NEW.width_in)
           IS DISTINCT FROM (OLD.product_id, OLD.color_id, OLD.pieces, OLD.length_in, OLD.width_in) THEN
        NEW.done_at := NULL;
        NEW.done_by := NULL;
        NEW.done_by_name := NULL;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER order_items_undone BEFORE UPDATE ON order_items
    FOR EACH ROW EXECUTE FUNCTION fn_order_item_undone();
