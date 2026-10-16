-- Intuit's id for each API call (the intuit_tid response header). Intuit support
-- asks for it when looking into a problem.
ALTER TABLE qbo_sync_log ADD COLUMN intuit_tid text;
