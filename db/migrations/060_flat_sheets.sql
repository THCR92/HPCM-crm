-- Tyler, 2026-11-13: flat sheets aren't finished stock; they get their own page like coils.
-- One row per color, gauge and sheet size, with every change logged.
CREATE TABLE IF NOT EXISTS flat_sheets (
    flat_sheet_id  serial PRIMARY KEY,
    color_id       int REFERENCES colors,
    gauge_id       smallint REFERENCES gauges,
    width_in       numeric(7,3) NOT NULL DEFAULT 48 CHECK (width_in > 0),
    length_in      numeric(7,3) NOT NULL CHECK (length_in > 0),
    qty_on_hand    int NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
    location       text,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (color_id, gauge_id, width_in, length_in)
);

CREATE TABLE IF NOT EXISTS flat_sheet_transactions (
    flat_sheet_txn_id bigserial PRIMARY KEY,
    flat_sheet_id     int NOT NULL REFERENCES flat_sheets ON DELETE CASCADE,
    reason            text NOT NULL CHECK (reason IN ('receive', 'sheared', 'used', 'scrap', 'count')),
    qty_delta         int NOT NULL,
    coil_id           int REFERENCES coils,
    lf_used           numeric(10,1),
    note              text,
    performed_by      text,
    occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flat_sheet_txn_sheet ON flat_sheet_transactions (flat_sheet_id, occurred_at);

-- Flat sheets that were put in Finished stock move here (gauge unknown, 48" wide).
INSERT INTO flat_sheets (color_id, width_in, length_in, qty_on_hand)
SELECT fg.color_id, 48, fg.length_in, sum(fg.qty_on_hand)
FROM finished_goods fg JOIN products p USING (product_id)
WHERE p.category = 'flat_sheet' AND fg.qty_on_hand > 0
GROUP BY fg.color_id, fg.length_in
ON CONFLICT DO NOTHING;
INSERT INTO flat_sheet_transactions (flat_sheet_id, reason, qty_delta, note)
SELECT flat_sheet_id, 'count', qty_on_hand, 'Moved from Finished stock' FROM flat_sheets WHERE qty_on_hand > 0
  AND NOT EXISTS (SELECT 1 FROM flat_sheet_transactions t WHERE t.flat_sheet_id = flat_sheets.flat_sheet_id);
INSERT INTO finished_goods_transactions (finished_good_id, txn_type, qty_delta, note)
SELECT fg.finished_good_id, 'adjust', -fg.qty_on_hand, 'Moved to Flat sheets'
FROM finished_goods fg JOIN products p USING (product_id)
WHERE p.category = 'flat_sheet' AND fg.qty_on_hand > 0;
