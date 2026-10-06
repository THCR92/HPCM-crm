-- Coils are bought and used by the linear foot, so footage replaces weight as
-- the running balance. Weight on receipt stays as an optional record.
-- (Existing weight figures are converted with the gauge weight per sq ft.)

DROP VIEW v_coil_stock_summary;
DROP VIEW v_coil_inventory;

-- Coils ---------------------------------------------------------------------
ALTER TABLE coils
    ADD COLUMN initial_lf  numeric(10,1),
    ADD COLUMN current_lf  numeric(10,1),
    ADD COLUMN cost_per_lf numeric(10,4);
UPDATE coils c
   SET initial_lf = round(c.initial_weight_lb / (g.weight_lb_per_sqft * c.width_in / 12.0), 1),
       current_lf = round(c.current_weight_lb / (g.weight_lb_per_sqft * c.width_in / 12.0), 1)
  FROM gauges g WHERE g.gauge_id = c.gauge_id;
ALTER TABLE coils DROP CONSTRAINT coils_check;
ALTER TABLE coils DROP COLUMN current_weight_lb;
ALTER TABLE coils
    ALTER COLUMN initial_lf SET NOT NULL,
    ALTER COLUMN current_lf SET NOT NULL,
    ALTER COLUMN initial_weight_lb DROP NOT NULL,
    ADD CONSTRAINT coils_initial_lf_check CHECK (initial_lf > 0),
    ADD CONSTRAINT coils_current_lf_check CHECK (current_lf >= 0 AND current_lf <= initial_lf);
COMMENT ON COLUMN coils.initial_weight_lb IS 'Optional: weight on the tag when received';

-- Coil ledger ---------------------------------------------------------------
ALTER TABLE coil_transactions ADD COLUMN lf_delta numeric(10,1);
UPDATE coil_transactions t
   SET lf_delta = round(t.weight_delta_lb / (g.weight_lb_per_sqft * c.width_in / 12.0), 1)
  FROM coils c JOIN gauges g USING (gauge_id) WHERE c.coil_id = t.coil_id;
ALTER TABLE coil_transactions DROP CONSTRAINT coil_transactions_check;
ALTER TABLE coil_transactions DROP COLUMN weight_delta_lb;
ALTER TABLE coil_transactions
    ALTER COLUMN lf_delta SET NOT NULL,
    ADD CONSTRAINT coil_transactions_lf_check CHECK (
        (txn_type = 'receive' AND lf_delta > 0)
     OR (txn_type IN ('production', 'scrap', 'return_to_vendor') AND lf_delta < 0)
     OR  txn_type = 'reweigh_adjust');   -- now "count correction"

-- Production runs -------------------------------------------------------------
ALTER TABLE production_runs ADD COLUMN lf_used numeric(10,1), ADD COLUMN scrap_lf numeric(10,1) NOT NULL DEFAULT 0;
UPDATE production_runs r
   SET lf_used  = round(r.weight_used_lb / (g.weight_lb_per_sqft * c.width_in / 12.0), 1),
       scrap_lf = round(r.scrap_lb / (g.weight_lb_per_sqft * c.width_in / 12.0), 1)
  FROM coils c JOIN gauges g USING (gauge_id) WHERE c.coil_id = r.coil_id;
ALTER TABLE production_runs DROP COLUMN weight_used_lb, DROP COLUMN scrap_lb;
ALTER TABLE production_runs
    ALTER COLUMN lf_used SET NOT NULL,
    ADD CONSTRAINT production_runs_lf_used_check CHECK (lf_used > 0),
    ADD CONSTRAINT production_runs_scrap_lf_check CHECK (scrap_lf >= 0 AND scrap_lf <= lf_used);
COMMENT ON COLUMN production_runs.lf_used IS 'Coil footage used, including scrap_lf';

-- Triggers keep coils.current_lf in step with the ledger ----------------------
CREATE OR REPLACE FUNCTION fn_apply_coil_txn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.txn_type = 'receive' THEN
        RETURN NEW;  -- receipt footage is set on the coil row itself
    END IF;
    UPDATE coils
       SET current_lf = current_lf + NEW.lf_delta,
           status = CASE WHEN current_lf + NEW.lf_delta <= 0
                         THEN 'depleted'::coil_status ELSE status END
     WHERE coil_id = NEW.coil_id;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fn_coil_received() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO coil_transactions (coil_id, txn_type, lf_delta, note)
    VALUES (NEW.coil_id, 'receive', NEW.initial_lf, 'Coil received');
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fn_production_run_post() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    remaining numeric;
    tag       text;
BEGIN
    SELECT current_lf, coil_tag INTO remaining, tag FROM coils WHERE coil_id = NEW.coil_id FOR UPDATE;
    IF NEW.lf_used > remaining THEN
        RAISE EXCEPTION 'This uses % LF but coil % has only % LF left. Correct the coil''s footage first if it''s wrong.',
            trim_scale(NEW.lf_used), tag, trim_scale(remaining);
    END IF;

    INSERT INTO coil_transactions (coil_id, txn_type, lf_delta, production_run_id, performed_by)
    VALUES (NEW.coil_id, 'production', -(NEW.lf_used - NEW.scrap_lf), NEW.production_run_id, NEW.operator);
    IF NEW.scrap_lf > 0 THEN
        INSERT INTO coil_transactions (coil_id, txn_type, lf_delta, production_run_id, performed_by)
        VALUES (NEW.coil_id, 'scrap', -NEW.scrap_lf, NEW.production_run_id, NEW.operator);
    END IF;

    IF NEW.finished_good_id IS NOT NULL THEN
        INSERT INTO finished_goods_transactions
            (finished_good_id, txn_type, qty_delta, production_run_id, performed_by)
        VALUES (NEW.finished_good_id, 'produce', NEW.pieces, NEW.production_run_id, NEW.operator);
    END IF;
    RETURN NEW;
END $$;

-- Coil list for the app, with the color label (supplier and finish).
CREATE VIEW v_coils AS
SELECT c.*, g.gauge, col.label AS color_label, col.name AS color_name, s.name AS supplier_name
FROM coils c
JOIN gauges g USING (gauge_id)
JOIN v_colors col ON col.color_id = c.color_id
LEFT JOIN suppliers s ON s.supplier_id = c.supplier_id;
