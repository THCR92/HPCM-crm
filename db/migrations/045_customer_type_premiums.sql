-- Tyler, 2026-11-11: a "Supply house" customer type, and a price premium per customer type
-- (a percent on price list prices; negative is a discount). Rows are added when a premium is
-- first set on the Price list page; a type without a row pays list price.
ALTER TYPE customer_type ADD VALUE IF NOT EXISTS 'supply_house' BEFORE 'commercial';

CREATE TABLE customer_type_premiums (
    customer_type customer_type PRIMARY KEY,
    premium_pct   numeric(6,2) NOT NULL DEFAULT 0 CHECK (premium_pct > -100 AND premium_pct <= 500),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Tyler 2026-11-11: homeowners start at +13%.
INSERT INTO customer_type_premiums (customer_type, premium_pct) VALUES ('homeowner', 13) ON CONFLICT DO NOTHING;
