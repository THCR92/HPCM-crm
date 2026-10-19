-- Length check photos: before an order is ready, each line gets a photo of the
-- pieces with a tape measure (panels, trim, closures, screws, accessories).
-- The customer sees them in the portal.
ALTER TABLE order_attachments ADD COLUMN is_proof boolean NOT NULL DEFAULT false;
