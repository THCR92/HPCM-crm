-- Tyler, 2026-11-12: customer portal logins have a role.
--   admin:   sees everything, manages their own team's logins, places orders.
--   manager: sees everything, accepts quotes and places orders.
--   sales:   writes quotes (sent to HPCM to confirm), sees only their own.
-- sees_all and can_approve follow the role (kept so older code still reads them).
ALTER TABLE customer_logins ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'manager'
  CHECK (role IN ('admin', 'manager', 'sales'));
UPDATE customer_logins SET role = CASE WHEN sees_all THEN 'manager' ELSE 'sales' END;
-- Each customer's first login that sees everything becomes its Admin.
UPDATE customer_logins l SET role = 'admin'
FROM (SELECT DISTINCT ON (customer_id) login_id FROM customer_logins
      WHERE sees_all ORDER BY customer_id, active DESC, login_id) f
WHERE l.login_id = f.login_id;

CREATE OR REPLACE FUNCTION customer_login_role_sync() RETURNS trigger AS $$
BEGIN
  NEW.sees_all := NEW.role <> 'sales';
  NEW.can_approve := NEW.role <> 'sales';
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS customer_login_role_sync ON customer_logins;
CREATE TRIGGER customer_login_role_sync BEFORE INSERT OR UPDATE ON customer_logins
  FOR EACH ROW EXECUTE FUNCTION customer_login_role_sync();
UPDATE customer_logins SET role = role;

-- A quote written in the portal is confirmed by HPCM before it can be ordered; a manager
-- or admin at the customer places the order from the portal.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hpcm_confirmed_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hpcm_confirmed_by text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS placed_in_portal boolean NOT NULL DEFAULT false;

-- Open portal quotes: sending one counts as the customer's yes. Ones the office already
-- saved count as confirmed by HPCM; the rest wait on the office.
UPDATE orders SET customer_decision = 'approved', customer_decided_at = COALESCE(updated_at, created_at),
       customer_decided_by = COALESCE(created_by, 'Sent from the portal')
WHERE from_portal AND status = 'quote' AND customer_decision IS NULL;
UPDATE orders SET hpcm_confirmed_at = COALESCE(updated_at, now()), hpcm_confirmed_by = updated_by
WHERE from_portal AND status = 'quote' AND updated_by IS NOT NULL AND updated_by NOT LIKE '%(customer)';
