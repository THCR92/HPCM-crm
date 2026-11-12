-- Tyler, 2026-11-12: Capitol Roofing's open quotes get VIP Contractor prices (15% below list).
-- They were written at list price (the Contractor type had no premium), so each line priced
-- from the price list comes down 15%, like a new line would. Lines for items with no list
-- price (priced by hand) stay as they are. Quotes written or edited after VIP pricing went
-- live (migration 053) already have it, so they're left alone.
UPDATE order_items oi
SET unit_price = round(oi.unit_price * 0.85, 2)
FROM orders o
JOIN customers c USING (customer_id)
WHERE oi.order_id = o.order_id
  AND o.status = 'quote'
  AND c.customer_type = 'vip_contractor'
  AND c.display_name ILIKE 'capitol roofing%'
  AND c.premium_pct IS NULL
  AND o.updated_at < (SELECT applied_at FROM schema_migrations WHERE name = '053_vip_contractor_pricing.sql')
  AND EXISTS (SELECT 1 FROM v_current_prices cp WHERE cp.product_id = oi.product_id AND cp.unit_price IS NOT NULL);
