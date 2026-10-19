-- Customer portal: customers sign in at /portal to see their quotes and orders,
-- approve or decline quotes, and (later) build quotes and add drawings.
-- It's off for every customer until a Manager or Admin turns it on, and each
-- customer can be set to see line prices, order totals, both or neither.

ALTER TABLE customers
    ADD COLUMN portal_enabled      boolean NOT NULL DEFAULT false,
    ADD COLUMN portal_line_prices  boolean NOT NULL DEFAULT true,
    ADD COLUMN portal_totals       boolean NOT NULL DEFAULT true;

-- The person who signs in for a customer: one login per customer for now (Tyler 2026-10-19).
-- They're invited by a link they open to set their own password.
CREATE TABLE customer_logins (
    login_id          serial PRIMARY KEY,
    customer_id       int NOT NULL REFERENCES customers ON DELETE CASCADE,
    full_name         text NOT NULL,
    email             text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    phone             text,
    can_approve       boolean NOT NULL DEFAULT true,
    password_hash     text,                       -- null until they open the invite and set one
    invite_token      text UNIQUE,                -- set-password link (invite or reset)
    invite_expires_at timestamptz,
    active            boolean NOT NULL DEFAULT true,
    last_login_at     timestamptz,
    created_by        text,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_logins_email ON customer_logins (lower(email));
CREATE UNIQUE INDEX customer_logins_one_per_customer ON customer_logins (customer_id);

CREATE TABLE customer_sessions (
    session_id    text PRIMARY KEY,
    login_id      int NOT NULL REFERENCES customer_logins ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL
);
CREATE INDEX customer_sessions_login ON customer_sessions (login_id);

-- The customer's answer on a quote. Approving still needs the shop's own approval
-- (a Manager or Admin moves it to Confirmed); declining leaves it a quote to revise or cancel.
ALTER TABLE orders
    ADD COLUMN portal_hidden          boolean NOT NULL DEFAULT false,  -- staff can keep a draft out of the portal
    ADD COLUMN customer_decision      text CHECK (customer_decision IN ('approved', 'declined')),
    ADD COLUMN customer_decided_at    timestamptz,
    ADD COLUMN customer_decided_by    text,
    ADD COLUMN customer_decision_note text,
    ADD COLUMN customer_decline_reason text;

-- Managers get the new "portal" permission like they'd have had it from the start.
UPDATE users SET permissions = array_append(permissions, 'portal')
WHERE role = 'manager' AND NOT ('portal' = ANY (permissions));

-- Every email the CRM sends (portal invites, password links, notices), and whether it went.
CREATE TABLE email_log (
    email_id    bigserial PRIMARY KEY,
    sent_at     timestamptz NOT NULL DEFAULT now(),
    to_address  text NOT NULL,
    subject     text NOT NULL,
    kind        text,
    order_id    bigint,
    ok          boolean NOT NULL,
    error       text
);
CREATE INDEX email_log_sent ON email_log (sent_at DESC);
