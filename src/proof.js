// Length check photos: every line that leaves the shop (not services or tool
// rentals) needs at least one photo before the order can be marked ready.
const { query } = require('./db');
const { html } = require('./html');

const NEEDS_PHOTO = "p.category NOT IN ('service', 'delivery') AND NOT p.is_rental";

// Lines on the order still missing a photo, in line order.
async function missingPhotos(orderId, db = { query }) {
  const { rows } = await db.query(`
    SELECT oi.order_item_id, oi.line_no, p.name AS product_name, fn_format_length(oi.length_in) AS length_display
    FROM order_items oi JOIN products p USING (product_id)
    WHERE oi.order_id = $1 AND ${NEEDS_PHOTO}
      AND NOT EXISTS (SELECT 1 FROM order_attachments a WHERE a.order_item_id = oi.order_item_id AND a.is_proof)
    ORDER BY oi.line_no`, [orderId]);
  return rows;
}

const missingText = (rows) => `Take a length check photo of every line first (a tape measure on the pieces). Still needed: ${
  rows.map((r) => `line ${r.line_no} (${r.length_display ? `${r.length_display} ` : ''}${r.product_name})`).join(', ')}.`;

// Photos on an order, by line.
async function photosByLine(orderId) {
  const { rows } = await query(`SELECT attachment_id, order_item_id, filename, uploaded_by, created_at FROM order_attachments
    WHERE order_id = $1 AND is_proof ORDER BY attachment_id`, [orderId]);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.order_item_id)) by.set(r.order_item_id, []);
    by.get(r.order_item_id).push(r);
  }
  return by;
}

// Thumbnails for one line, plus a "Photo" button (opens the camera on a phone).
// `base` is where the photos are served: /orders/:id/attachments or /portal/orders/:id/files.
const photoCell = ({ orderId, lineId, photos = [], canAdd, base }) => html`<div class="photo-cell">
  ${photos.map((ph) => html`<a href="${base}/${ph.attachment_id}" target="_blank" rel="noopener" title="${ph.uploaded_by ? `By ${ph.uploaded_by}` : ''}">
    <img src="${base}/${ph.attachment_id}" alt="Length check photo" loading="lazy"></a>`)}
  ${canAdd ? html`<form class="photo-form inline" data-action="/orders/${orderId}/photos?line=${lineId}">
    <label class="btn small photo-btn">📷 ${photos.length ? 'Another' : 'Photo'}<input type="file" accept="image/*" capture="environment" hidden></label>
    <span class="photo-status muted small"></span></form>` : ''}
</div>`;

module.exports = { NEEDS_PHOTO, missingPhotos, missingText, photosByLine, photoCell };
