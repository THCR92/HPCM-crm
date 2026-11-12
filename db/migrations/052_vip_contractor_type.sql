-- Tyler, 2026-11-12: a "VIP Contractor" customer type (15% below list, set in 053), and a
-- price adjustment on each customer that, when filled in, replaces their type's.
-- (A new enum value can't be used until this migration commits, so 053 uses it.)
ALTER TYPE customer_type ADD VALUE IF NOT EXISTS 'vip_contractor' AFTER 'contractor';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS premium_pct numeric(6,2)
    CHECK (premium_pct IS NULL OR (premium_pct > -100 AND premium_pct <= 500));
