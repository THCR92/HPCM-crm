-- QuickBooks Online connection, both ways.
--   CRM -> QuickBooks: customers when they're added or edited; orders as invoices
--   when they're completed (picked up or delivered).
--   QuickBooks -> CRM: customers added or edited in QuickBooks (webhooks, plus a
--   catch-up check every few minutes in case a webhook is missed).

-- The one connected QuickBooks company. Tokens are encrypted with a key made
-- from the app's client secret (src/qbo.js).
CREATE TABLE qbo_connection (
    id                  smallint      PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    environment         text          NOT NULL CHECK (environment IN ('sandbox', 'production')),
    realm_id            text          NOT NULL,
    company_name        text,
    access_token        text          NOT NULL,
    access_expires_at   timestamptz   NOT NULL,
    refresh_token       text          NOT NULL,
    refresh_expires_at  timestamptz,
    connected_by        text,
    connected_at        timestamptz   NOT NULL DEFAULT now(),
    income_account_id   text,                                   -- new QuickBooks items post sales here
    customers_checked_at timestamptz,                           -- QuickBooks customer changes up to here are in the CRM
    last_error          text
);

-- The QuickBooks company the CRM's qbo_* ids belong to. Connecting a different
-- company (the test company, then the real one) clears the old ids.
INSERT INTO app_settings (key, value) VALUES ('qbo_realm_id', '') ON CONFLICT DO NOTHING;

-- One-time codes for the Connect button (checked when QuickBooks sends the person back).
CREATE TABLE qbo_oauth_states (
    state               text          PRIMARY KEY,
    user_id             int           REFERENCES users ON DELETE CASCADE,
    created_at          timestamptz   NOT NULL DEFAULT now()
);

ALTER TABLE customers
    ADD COLUMN qbo_synced_at  timestamptz,
    ADD COLUMN qbo_last_error text;

ALTER TABLE qbo_sync_log ALTER COLUMN local_id DROP NOT NULL;
ALTER TABLE qbo_sync_log ADD COLUMN error text;
