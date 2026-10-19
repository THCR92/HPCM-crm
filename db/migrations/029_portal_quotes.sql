-- Quotes customers write themselves in the portal, and drawings they upload.
ALTER TABLE orders ADD COLUMN from_portal boolean NOT NULL DEFAULT false;
ALTER TABLE order_attachments ADD COLUMN from_customer boolean NOT NULL DEFAULT false;
