-- Tyler, 2026-11-09: a "Forgot password?" link on the sign-in page emails a one-time link
-- (good for an hour) to set a new password.
ALTER TABLE users
    ADD COLUMN reset_token text UNIQUE,
    ADD COLUMN reset_expires_at timestamptz;
