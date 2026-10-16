-- Customers that came in from QuickBooks (not typed into the CRM). Used to clear
-- out the QuickBooks test company's sample customers before connecting the real books.
ALTER TABLE customers ADD COLUMN created_from_qbo boolean NOT NULL DEFAULT false;

-- Customers brought in so far: added after QuickBooks was connected and matched
-- with QuickBooks in the same moment they were added.
UPDATE customers c SET created_from_qbo = true
FROM qbo_connection q
WHERE c.qbo_customer_id IS NOT NULL
  -- From the first connection (Connect again moves connected_at; the activity list keeps the first).
  AND c.created_at >= LEAST(q.connected_at, (SELECT min(created_at) FROM qbo_sync_log)) - interval '1 minute'
  AND NOT EXISTS (SELECT 1 FROM qbo_sync_log l
                  WHERE l.local_table = 'customers' AND l.local_id = c.customer_id AND l.operation = 'create');
