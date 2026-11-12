-- Tyler, 2026-11-12: VIP Contractors pay 15% below the price list; Capitol Roofing is one.
INSERT INTO customer_type_premiums (customer_type, premium_pct) VALUES ('vip_contractor', -15)
ON CONFLICT (customer_type) DO NOTHING;
UPDATE customers SET customer_type = 'vip_contractor' WHERE display_name ILIKE 'capitol roofing%';

-- Tyler, 2026-11-12: #10 1.5" Woodtite screws back to $30 a bag.
INSERT INTO product_prices (product_id, unit_price, effective_from, source)
SELECT product_id, 30, current_date, 'Tyler 2026-11-12'
FROM products WHERE sku = 'SCR-10-1-5-WOODTITE-SCREWS'
ON CONFLICT (product_id, effective_from) DO UPDATE SET unit_price = EXCLUDED.unit_price, source = EXCLUDED.source;
