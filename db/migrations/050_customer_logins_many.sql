-- Tyler, 2026-11-12: a customer can have several portal logins. Each login either sees
-- all of the customer's quotes and orders (e.g. Capitol Roofing's production coordinator)
-- or only the ones that are theirs (a salesman). Existing logins see everything, as before.
DROP INDEX IF EXISTS customer_logins_one_per_customer;
ALTER TABLE customer_logins ADD COLUMN IF NOT EXISTS sees_all boolean NOT NULL DEFAULT true;

-- Whose quote or order it is, among the customer's logins: set when a login writes a quote
-- in the portal, or picked on the quote form ("Who it's for"). Null = only logins that see all.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_login_id int REFERENCES customer_logins ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS orders_customer_login ON orders (customer_login_id) WHERE customer_login_id IS NOT NULL;
