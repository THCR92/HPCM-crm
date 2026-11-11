-- Tyler, 2026-11-11: a base price premium per finish (Textured, Metallic, ...), set on the
-- Colors page. Setting it sets every color in that finish; each color can still be changed
-- on its own after. New colors start at their finish's base premium. NULL = not set yet.
ALTER TABLE color_finishes ADD COLUMN IF NOT EXISTS premium_pct numeric(6,2) CHECK (premium_pct >= 0);
