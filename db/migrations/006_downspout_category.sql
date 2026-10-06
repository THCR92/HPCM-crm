-- Downspouts and elbows get their own product group (used by migration 007;
-- a new enum value can't be used in the same transaction that adds it).
ALTER TYPE product_category ADD VALUE IF NOT EXISTS 'downspout' AFTER 'flat_sheet';
