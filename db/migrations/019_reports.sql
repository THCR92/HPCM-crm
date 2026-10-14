-- Reports: record when each order changes status, so the Reports page can
-- measure quote win rates, days to approve, lead times and on-time delivery.

-- Every status change, oldest first. Filled by the trigger below.
CREATE TABLE order_status_history (
    history_id   bigserial   PRIMARY KEY,
    order_id     bigint      NOT NULL REFERENCES orders ON DELETE CASCADE,
    from_status  order_status,                       -- NULL when the quote was written
    to_status    order_status NOT NULL,
    changed_by   text,
    changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, changed_at);

-- When a quote was approved (NULL while it is a quote, or if it was never approved),
-- when it was cancelled, and why a quote was lost.
ALTER TABLE orders
    ADD COLUMN approved_at  timestamptz,
    ADD COLUMN cancelled_at timestamptz,
    ADD COLUMN lost_reason  text CHECK (lost_reason IN ('price', 'competitor', 'timing', 'no_response', 'changed_scope', 'other'));

CREATE FUNCTION fn_order_status_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status NOT IN ('quote', 'cancelled') THEN
            NEW.approved_at := COALESCE(NEW.approved_at, now());
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.status = 'quote' THEN
            NEW.approved_at := NULL;
            NEW.cancelled_at := NULL;
            NEW.lost_reason := NULL;
        ELSIF NEW.status = 'cancelled' THEN
            NEW.cancelled_at := now();
        ELSE
            NEW.approved_at := COALESCE(NEW.approved_at, now());
            NEW.cancelled_at := NULL;
            NEW.lost_reason := NULL;
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER orders_status_stamp BEFORE INSERT OR UPDATE OF status ON orders
    FOR EACH ROW EXECUTE FUNCTION fn_order_status_stamp();

CREATE FUNCTION fn_order_status_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO order_status_history (order_id, from_status, to_status, changed_by)
        VALUES (NEW.order_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
                COALESCE(NEW.updated_by, NEW.created_by));
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER orders_status_log AFTER INSERT OR UPDATE OF status ON orders
    FOR EACH ROW EXECUTE FUNCTION fn_order_status_log();

-- Fill in what we can for orders written before this. The order date is the
-- day a quote was approved, so it stands in for the approval time.
UPDATE orders SET approved_at = (ordered_on + time '12:00') AT TIME ZONE 'America/Denver'
 WHERE status NOT IN ('quote', 'cancelled');
UPDATE orders SET cancelled_at = updated_at WHERE status = 'cancelled';
INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, changed_at)
SELECT order_id, NULL, 'quote', created_by, created_at FROM orders;
INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, changed_at)
SELECT order_id, 'quote', status, approved_by, approved_at FROM orders WHERE approved_at IS NOT NULL;

-- Admins and Managers see the Reports page.
UPDATE users SET permissions = array_append(permissions, 'reports')
WHERE role IN ('admin', 'manager') AND NOT 'reports' = ANY (permissions);
