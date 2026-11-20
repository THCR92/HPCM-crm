-- Tyler, 2026-11-20: who gets a customer's invoices and Ready emails, set per customer so
-- any contractor can have the same setup.
--  * customers.invoice_email: QuickBooks invoices always go here (Capitol Roofing:
--    invoices@capitolroofinginc.com), whoever placed the order.
--  * customer_logins.ready_emails: this login gets the Ready email for orders it put in
--    (or that are for it).
--  * customers.ready_login_id: everyone else's Ready emails (other sales reps, orders put
--    in at the shop) go to this login (Capitol Roofing: Taylor, production coordinator).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS invoice_email text CHECK (length(invoice_email) <= 100);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ready_login_id integer REFERENCES customer_logins (login_id) ON DELETE SET NULL;
ALTER TABLE customer_logins ADD COLUMN IF NOT EXISTS ready_emails boolean NOT NULL DEFAULT true;

UPDATE customers SET invoice_email = 'invoices@capitolroofinginc.com'
WHERE display_name ILIKE 'capitol roofing%' AND invoice_email IS NULL;

UPDATE customers c SET ready_login_id = (
  SELECT l.login_id FROM customer_logins l
  WHERE l.customer_id = c.customer_id AND l.active AND l.full_name ILIKE 'taylor%'
  ORDER BY l.login_id LIMIT 1)
WHERE c.display_name ILIKE 'capitol roofing%' AND c.ready_login_id IS NULL;

-- At Capitol, only Taylor, David and Fred get their own; other sales reps' go to Taylor.
UPDATE customer_logins l SET ready_emails = false
FROM customers c
WHERE c.customer_id = l.customer_id AND c.display_name ILIKE 'capitol roofing%'
  AND l.role = 'sales' AND l.full_name !~* '^(taylor|david|fred)\M';
