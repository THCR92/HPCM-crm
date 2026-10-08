-- Individual sign-ins with roles. A role (admin, manager, sales, production)
-- fills in a starting set of permissions; an Admin can then tick permissions
-- on or off per person. Admins can always do everything, including managing users.

CREATE TABLE users (
    user_id         serial PRIMARY KEY,
    email           text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    full_name       text NOT NULL,
    role            text NOT NULL CHECK (role IN ('admin', 'manager', 'sales', 'production')),
    permissions     text[] NOT NULL DEFAULT '{}',
    password_hash   text NOT NULL,
    active          boolean NOT NULL DEFAULT true,
    last_login_at   timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email ON users (lower(email));

-- Signed-in browsers. The cookie holds only the random id; it expires after
-- 30 days without use.
CREATE TABLE user_sessions (
    session_id      text PRIMARY KEY,
    user_id         int NOT NULL REFERENCES users ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL
);
CREATE INDEX user_sessions_user ON user_sessions (user_id);

-- Who did what.
ALTER TABLE orders ADD COLUMN created_by text, ADD COLUMN updated_by text, ADD COLUMN approved_by text;
ALTER TABLE order_attachments ADD COLUMN uploaded_by text;
