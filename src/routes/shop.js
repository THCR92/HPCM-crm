// Shop photos on a phone (Tyler 2026-11-16): jobs in the shop, then one job with a big
// camera button for each line's length check photo and for photos of the packed load.
const { query } = require('../db');
const { html, layout, num, date } = require('../html');
const { need } = require('../auth');
const proof = require('../proof');

const router = require('../async-router')();

const IN_SHOP = "('confirmed', 'in_production', 'ready')";
const PHOTO_STATUSES = ['confirmed', 'in_production', 'ready', 'completed'];
const STEP = { confirmed: 'Ordered', in_production: 'In production', ready: 'Ready', completed: 'Completed' };
const weekday = (d) => new Date(`${String(d instanceof Date ? d.toISOString() : d).slice(0, 10)}T12:00:00Z`)
  .toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

// Big buttons: one opens the camera, one picks photos already taken (several at once).
const cameraButtons = (action) => html`<form class="photo-form shop-photo" data-action="${action}">
  <label class="btn primary big-photo">📷 Take photo<input type="file" accept="image/*" capture="environment" hidden></label>
  <label class="btn big-photo">🖼 From phone<input type="file" accept="image/*" multiple hidden></label>
  <span class="photo-status muted small"></span></form>`;

const thumbs = (orderId, photos) => (photos.length ? html`<div class="shop-thumbs">${photos.map((ph) => html`
  <a href="/orders/${orderId}/attachments/${ph.attachment_id}" target="_blank" rel="noopener">
    <img src="/orders/${orderId}/attachments/${ph.attachment_id}" alt="Photo" loading="lazy"></a>`)}</div>` : '');

router.get('/shop', need('production', 'drawings'), async (req, res) => {
  const q = String(req.query.q || '').trim();
  const { rows } = await query(`
    SELECT o.order_id, o.order_number, o.status, o.need_by, o.job_name, o.po_number, c.display_name,
           count(oi.order_item_id)::int AS lines,
           count(oi.order_item_id) FILTER (WHERE EXISTS (SELECT 1 FROM order_attachments a
             WHERE a.order_item_id = oi.order_item_id AND a.is_proof))::int AS done,
           (SELECT count(*) FROM order_attachments a WHERE a.order_id = o.order_id AND a.is_proof AND a.order_item_id IS NULL)::int AS packed
    FROM orders o JOIN customers c USING (customer_id)
    LEFT JOIN order_items oi ON oi.order_id = o.order_id
      AND EXISTS (SELECT 1 FROM products p WHERE p.product_id = oi.product_id AND ${proof.NEEDS_PHOTO})
    WHERE o.status IN ${IN_SHOP}
      AND ($1 = '' OR o.order_number ILIKE '%' || $1 || '%' OR c.display_name ILIKE '%' || $1 || '%'
           OR o.job_name ILIKE '%' || $1 || '%' OR o.po_number ILIKE '%' || $1 || '%')
    GROUP BY o.order_id, c.display_name
    ORDER BY o.need_by NULLS LAST, o.order_id`, [q]);
  res.send(layout({
    title: 'Shop photos', active: '/shop',
    body: html`
    <h1>Shop photos</h1>
    <form method="get" action="/shop" class="shop-search"><input name="q" value="${q}" placeholder="Order #, customer, job or PO" type="search">
      <button class="btn">Find</button></form>
    ${rows.length ? html`<div class="shop-jobs">${rows.map((o) => html`
      <a class="shop-job" href="/shop/orders/${o.order_id}">
        <span class="shop-job-top"><strong>${o.order_number}</strong> <span class="badge badge-${o.status}">${STEP[o.status]}</span>
          <span class="shop-need">${o.need_by ? `Need ${weekday(o.need_by)} ${date(o.need_by)}` : 'No need-by date'}</span></span>
        <span class="shop-cust">${o.display_name}${o.job_name ? ` · ${o.job_name}` : ''}${o.po_number ? ` · PO ${o.po_number}` : ''}</span>
        <span class="muted small">${o.lines ? `${o.done} of ${o.lines} lines photographed` : 'No lines to photograph'}${
          o.packed ? ` · ${o.packed} packed photo${o.packed === 1 ? '' : 's'}` : ''}</span>
      </a>`)}</div>`
    : html`<p class="empty">${q ? 'No job in the shop matches that.' : 'No jobs in the shop right now.'}</p>`}`,
  }));
});

router.get('/shop/orders/:id(\\d+)', need('production', 'drawings'), async (req, res) => {
  const { rows: [o] } = await query(`SELECT o.order_id, o.order_number, o.status, o.need_by, o.job_name, o.po_number, c.display_name
    FROM orders o JOIN customers c USING (customer_id) WHERE o.order_id = $1`, [req.params.id]);
  if (!o) return res.status(404).send('Order not found');
  const { rows: lines } = await query(`
    SELECT oi.order_item_id, oi.line_no, oi.pieces, fn_format_length(oi.length_in) AS length_display, p.name AS product_name,
           col.name || CASE WHEN col.finish <> 'smooth' THEN ' (' || col.finish_label || ')' ELSE '' END AS color_name
    FROM order_items oi JOIN products p USING (product_id) LEFT JOIN v_colors col ON col.color_id = oi.color_id
    WHERE oi.order_id = $1 AND ${proof.NEEDS_PHOTO} ORDER BY oi.line_no`, [o.order_id]);
  const photos = await proof.photosByLine(o.order_id);
  const open = PHOTO_STATUSES.includes(o.status);
  const done = lines.filter((l) => photos.has(l.order_item_id)).length;
  res.send(layout({
    title: `Photos ${o.order_number}`, active: '/shop', scripts: ['/photos.js'],
    body: html`
    <p class="no-print"><a href="/shop">← All jobs</a></p>
    <h1>${o.order_number} <span class="badge badge-${o.status}">${STEP[o.status] || o.status}</span></h1>
    <p class="shop-cust">${o.display_name}${o.job_name ? ` · ${o.job_name}` : ''}${o.po_number ? ` · PO ${o.po_number}` : ''}<br>
      ${o.need_by ? html`<strong>Need ${weekday(o.need_by)} ${date(o.need_by)}</strong>` : ''}</p>
    ${open ? '' : html`<div class="alert">Photos can be added once the order is Ordered.</div>`}
    <section class="shop-card">
      <h2>Packed &amp; loaded</h2>
      <p class="muted small">The whole order bundled, wrapped or on the truck.</p>
      ${thumbs(o.order_id, photos.get(null) || [])}
      ${open ? cameraButtons(`/orders/${o.order_id}/photos?line=pack`) : ''}
    </section>
    <h2>Length check, line by line <span class="muted small">${done} of ${lines.length} done</span></h2>
    ${lines.map((l) => html`
    <section class="shop-card ${photos.has(l.order_item_id) ? 'has-photo' : ''}" id="line-${l.order_item_id}">
      <div class="shop-line"><span class="shop-line-no">${l.line_no}</span>
        <span><strong>${num(l.pieces)}${l.length_display ? ` × ${l.length_display}` : ''}</strong> ${l.product_name}
        ${l.color_name ? html`<span class="muted"> · ${l.color_name}</span>` : ''}</span>
        ${photos.has(l.order_item_id) ? html`<span class="shop-check" title="Has a photo">✓</span>` : ''}</div>
      ${thumbs(o.order_id, photos.get(l.order_item_id) || [])}
      ${open ? cameraButtons(`/orders/${o.order_id}/photos?line=${l.order_item_id}`) : ''}
    </section>`)}
    <p><a href="/orders/${o.order_id}">Open the full order</a></p>`,
  }));
});

module.exports = router;
