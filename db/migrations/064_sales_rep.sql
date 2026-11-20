-- Tyler, 2026-11-20: the customer's sales rep on each quote and order (e.g. Fred Roberts at
-- Capitol Roofing), shown on the quote and the cut sheet. Typed in-house, or the portal login
-- that wrote the quote.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sales_rep text CHECK (length(sales_rep) <= 100);

UPDATE orders o SET sales_rep = l.full_name
FROM customer_logins l
WHERE l.login_id = o.customer_login_id AND o.sales_rep IS NULL AND o.from_portal;
