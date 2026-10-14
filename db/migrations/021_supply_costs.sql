-- What supplies cost us. Each item keeps an average cost per unit (each, bag,
-- roll), updated when stock is received at a cost. Every movement records the
-- cost per unit at the time, so supplies used on orders have a cost of goods.

ALTER TABLE supply_stock ADD COLUMN avg_cost numeric(12,4) CHECK (avg_cost >= 0);
ALTER TABLE supply_transactions ADD COLUMN unit_cost numeric(12,4) CHECK (unit_cost >= 0);
COMMENT ON COLUMN supply_transactions.unit_cost IS 'receive: price paid per unit; other moves: the average cost at the time';

-- A receipt at a cost blends into the average: what was on the shelf at the old
-- average plus what came in at the new cost. A count with a cost sets it.
CREATE OR REPLACE FUNCTION fn_apply_supply_txn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    s supply_stock%ROWTYPE;
    shelf numeric;
BEGIN
    SELECT * INTO s FROM supply_stock WHERE supply_id = NEW.supply_id FOR UPDATE;
    shelf := greatest(s.qty_on_hand, 0);
    UPDATE supply_stock SET
        qty_on_hand = qty_on_hand + NEW.qty_delta,
        avg_cost = CASE
            WHEN NEW.unit_cost IS NULL THEN avg_cost
            WHEN NEW.txn_type = 'receive' AND NEW.qty_delta > 0 THEN
                CASE WHEN s.avg_cost IS NULL OR shelf = 0 THEN NEW.unit_cost
                     ELSE round((shelf * s.avg_cost + NEW.qty_delta * NEW.unit_cost) / (shelf + NEW.qty_delta), 4) END
            WHEN NEW.txn_type = 'count' THEN NEW.unit_cost
            ELSE avg_cost END,
        updated_at = now()
    WHERE supply_id = NEW.supply_id;
    RETURN NEW;
END $$;

-- Moves without a cost of their own take the average at the time.
CREATE FUNCTION fn_supply_txn_cost() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.unit_cost IS NULL AND NEW.txn_type IN ('order', 'adjust') THEN
        SELECT avg_cost INTO NEW.unit_cost FROM supply_stock WHERE supply_id = NEW.supply_id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER supply_txn_cost BEFORE INSERT ON supply_transactions
    FOR EACH ROW EXECUTE FUNCTION fn_supply_txn_cost();
