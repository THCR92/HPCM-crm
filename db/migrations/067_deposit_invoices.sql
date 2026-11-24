-- Tyler, 2026-11-24: on some orders HPCM asks for a deposit (usually half) before buying
-- materials. "Send deposit invoice" makes its own QuickBooks invoice (HP-n-D) for a percent
-- of the order's total with tax, on a "Customer Deposit" item that posts to a Customer
-- Deposits liability account (the CRM makes both). The full invoice at Ready then takes the
-- deposit off with a "Less deposit" line.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS deposit_pct numeric(5,2) CHECK (deposit_pct > 0 AND deposit_pct <= 100),
  ADD COLUMN IF NOT EXISTS deposit_invoice_amount numeric(12,2) CHECK (deposit_invoice_amount > 0),
  ADD COLUMN IF NOT EXISTS qbo_deposit_invoice_id text,
  ADD COLUMN IF NOT EXISTS deposit_doc_number text,
  ADD COLUMN IF NOT EXISTS deposit_invoiced_at timestamptz,
  ADD COLUMN IF NOT EXISTS deposit_balance numeric(12,2),
  ADD COLUMN IF NOT EXISTS deposit_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS deposit_error text;

ALTER TABLE qbo_connection ADD COLUMN IF NOT EXISTS deposit_item_id text;
