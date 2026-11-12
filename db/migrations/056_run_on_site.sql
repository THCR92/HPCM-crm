-- Tyler, 2026-11-12: "Run on site" (standing seam or Board & Batten rolled out at the job),
-- next to Pickup and Delivery. Delivery charges are figured from the driving miles, kept here.
ALTER TYPE fulfillment_method ADD VALUE IF NOT EXISTS 'run_on_site';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_miles numeric(7,1);
