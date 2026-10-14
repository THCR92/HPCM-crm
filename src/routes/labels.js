// Barcode labels, the scan box, and pack-and-check.
//
// Every label carries a QR code holding a link like https://www.hpcmcrm.net/s/C12,
// so a phone camera opens the page straight away, and a 2D barcode scanner
// (which types what it reads) works in the scan box at the top of every page.
//   HP-10023  an order         L<id>  one line of an order (a bundle or bag)
//   C<id>     a coil           S<id>  a supply shelf (item and color)
//   T<id>     a tool
const QRCode = require('qrcode');
const { query, tx } = require('../db');
const { html, raw, layout, num, date } = require('../html');
const { can, need, userName } = require('../auth');
const { syncOrderSupplies } = require('../supplies');

const router = require('../async-router')();

const SIZES = {
  sheet: 'Sheet labels, 4" × 2" (Avery 5163, 10 per page)',
  roll: 'Label printer, 4" × 2"',
  small: 'Label printer, 2.25" × 1.25"',
};
// Lines that aren't packed: services, tool rentals and delivery charges.
const PACKABLE = "p.category NOT IN ('service', 'delivery') AND NOT p.is_rental";
const PACK_STATUSES = ['confirmed', 'in_production', 'ready'];

const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

// What a scanned code (or a whole scanned link) points to, or null.
async function resolve(raw0) {
  let code = String(raw0 || '').trim();
  const m = code.match(/\/s\/([^/?#\s]+)/);
  if (m) code = decodeURIComponent(m[1]);
  if (!code) return null;
  const up = code.toUpperCase();
  let r;
  if (/^HP-?\d+$/.test(up)) {
    r = await query('SELECT order_id FROM orders WHERE order_number = $1', [up.replace(/^HP-?/, 'HP-')]);
    if (r.rows[0]) return { kind: 'order', id: r.rows[0].order_id, path: `/orders/${r.rows[0].order_id}` };
  }
  const k = up.match(/^([LCST])(\d+)$/);
  if (k) {
    const id = Number(k[2]);
    if (k[1] === 'L') {
      r = await query('SELECT order_id FROM order_items WHERE order_item_id = $1', [id]);
      if (r.rows[0]) return { kind: 'line', id, orderId: r.rows[0].order_id, path: `/orders/${r.rows[0].order_id}/pack` };
    }
    if (k[1] === 'C') {
      r = await query('SELECT coil_id FROM coils WHERE coil_id = $1', [id]);
      if (r.rows[0]) return { kind: 'coil', id, path: `/coils/${id}` };
    }
    if (k[1] === 'S') {
      r = await query('SELECT supply_id FROM supply_stock WHERE supply_id = $1', [id]);
      if (r.rows[0]) return { kind: 'supply', id, path: `/supplies/${id}` };
    }
    if (k[1] === 'T') {
      r = await query('SELECT tool_id FROM tools WHERE tool_id = $1', [id]);
      if (r.rows[0]) return { kind: 'tool', id, path: `/tools/${id}` };
    }
  }
  // Typed in by hand: a coil tag or tool tag.
  r = await query('SELECT coil_id FROM coils WHERE lower(coil_tag) = lower($1)', [code]);
  if (r.rows[0]) return { kind: 'coil', id: r.rows[0].coil_id, path: `/coils/${r.rows[0].coil_id}` };
  r = await query('SELECT tool_id FROM tools WHERE lower(tag) = lower($1)', [code]);
  if (r.rows[0]) return { kind: 'tool', id: r.rows[0].tool_id, path: `/tools/${r.rows[0].tool_id}` };
  return null;
}

const notFound = (code) => layout({
  title: 'Scan', body: html`<h1>Nothing found</h1>
  <p>No order, line, coil, supply or tool matches <strong>${code}</strong>.</p>
  <form method="get" action="/scan" class="card scan-big"><label>Scan or type a code
    <input name="code" autofocus autocomplete="off"></label><button class="btn primary">Open</button></form>`,
});

router.get('/s/:code', async (req, res) => {
  const hit = await resolve(req.params.code);
  if (!hit) return res.status(404).send(notFound(req.params.code));
  res.redirect(hit.path);
});
router.get('/scan', async (req, res) => {
  const hit = await resolve(req.query.code);
  if (!hit) return res.status(404).send(notFound(req.query.code || ''));
  res.redirect(hit.path);
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------
const qr = async (text) => raw(await QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }));

// label: { code, title, lines: [text], big }
async function labelPage(req, res, { title, labels, back }) {
  const size = SIZES[req.query.size] ? req.query.size : 'sheet';
  const base = baseUrl(req);
  const rendered = await Promise.all(labels.map(async (l) => html`
    <div class="label">
      <div class="qr">${await qr(`${base}/s/${l.code}`)}</div>
      <div class="text">
        ${l.big ? html`<div class="big">${l.big}</div>` : ''}
        <div class="title">${l.title}</div>
        ${l.lines.filter(Boolean).map((t) => html`<div class="line">${t}</div>`)}
        <div class="code">${l.code}</div>
      </div>
    </div>`));
  const qs = (s) => {
    const u = new URLSearchParams(req.query);
    u.set('size', s);
    return `?${u}`;
  };
  res.send(layout({
    title,
    body: html`
    <div class="no-print label-tools">
      <p><a href="${back}">← Back</a></p>
      <h1>${title}</h1>
      <p class="muted">${labels.length} label${labels.length === 1 ? '' : 's'}. Print with margins set to None and scale 100%.
        Scan with a phone camera or a 2D barcode scanner.</p>
      <div class="actions">${Object.entries(SIZES).map(([k, v]) => html`<a class="btn ${k === size ? 'primary' : ''}" href="${qs(k)}">${v}</a>`)}
        <button class="btn" onclick="window.print()">Print</button></div>
    </div>
    <div class="labels labels-${size}">${labels.length ? rendered : html`<p class="muted">Nothing to label.</p>`}</div>
    ${raw(`<style>@page { size: ${size === 'sheet' ? 'letter' : size === 'roll' ? '4in 2in' : '2.25in 1.25in'}; margin: ${size === 'sheet' ? '0.5in 0.156in' : '0'}; }</style>`)}`,
  }));
}

const lineText = (i) => {
  const len = i.length_display ? ` × ${i.length_display}` : '';
  const width = i.pricing_unit === 'sqft' && i.category === 'custom_trim' && i.width_in ? ` (${num(i.width_in, 3)}" girth)` : '';
  return `${num(i.pieces)}${len} ${i.product_name}${width}`;
};

async function orderLines(orderId) {
  const { rows } = await query(`
    SELECT oi.order_item_id, oi.line_no, oi.pieces, oi.pricing_unit, oi.width_in, oi.packed_at, oi.packed_by,
           fn_format_length(oi.length_in) AS length_display, p.name AS product_name, p.category,
           col.label AS color, g.gauge, os.area, os.label AS section_label, COALESCE(os.sort_order, 999) AS section_sort
    FROM order_items oi JOIN products p USING (product_id)
    LEFT JOIN v_colors col ON col.color_id = oi.color_id
    LEFT JOIN gauges g ON g.gauge_id = p.gauge_id
    LEFT JOIN order_sections os ON os.section_id = oi.section_id
    WHERE oi.order_id = $1 AND ${PACKABLE}
    ORDER BY section_sort, os.section_id, oi.line_no`, [orderId]);
  return rows;
}

const AREA = { roof: 'Roof', wall: 'Wall', trim: 'Trim', other: 'Other' };

router.get('/labels/order/:id(\\d+)', async (req, res) => {
  const { rows: [o] } = await query(`SELECT o.*, c.display_name AS customer FROM orders o JOIN customers c USING (customer_id)
    WHERE o.order_id = $1`, [req.params.id]);
  if (!o) return res.status(404).send('Order not found');
  const lines = await orderLines(o.order_id);
  const head = [o.customer, o.job_name, o.need_by ? `Need by ${date(o.need_by)}` : '', o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'];
  const labels = [{ code: o.order_number, big: o.order_number, title: 'Whole order', lines: [...head, `${lines.length} line${lines.length === 1 ? '' : 's'}`] }];
  const only = req.query.line ? Number(req.query.line) : null;
  for (const [n, l] of lines.entries()) {
    if (only && l.order_item_id !== only) continue;
    labels.push({
      code: `L${l.order_item_id}`, big: o.order_number, title: lineText(l),
      lines: [[l.color, l.gauge ? `${l.gauge} ga` : ''].filter(Boolean).join(' · '),
        `${o.customer}${o.job_name ? ` · ${o.job_name}` : ''}`,
        `${l.section_label || AREA[l.area] || ''}${l.section_label || l.area ? ' · ' : ''}line ${l.line_no} · ${n + 1} of ${lines.length}`],
    });
  }
  await labelPage(req, res, { title: `Labels for ${o.order_number}`, labels: only ? labels.slice(1) : labels, back: `/orders/${o.order_id}` });
});

router.get('/labels/coils', async (req, res) => {
  const one = Number(req.query.id) || null;
  const { rows } = await query(`SELECT * FROM v_coils WHERE ($1::int IS NULL AND status IN ('received', 'in_stock', 'on_machine')) OR coil_id = $1
    ORDER BY coil_tag`, [one]);
  await labelPage(req, res, {
    title: one ? `Label for coil ${rows[0]?.coil_tag || ''}` : 'Coil labels',
    back: one ? `/coils/${one}` : '/coils',
    labels: rows.map((c) => ({
      code: `C${c.coil_id}`, big: c.coil_tag, title: c.color_label,
      lines: [`${c.gauge} ga · ${num(c.width_in, 3)}" wide · ${num(c.initial_lf, 0)} LF`, c.supplier_name, `Received ${date(c.received_on)}`],
    })),
  });
});

router.get('/labels/supplies', async (req, res) => {
  const one = Number(req.query.id) || null;
  const { rows } = await query(`
    SELECT s.supply_id, s.location, p.name, col.label AS color, p.pricing_unit, p.pack_size
    FROM supply_stock s JOIN products p USING (product_id) LEFT JOIN v_colors col ON col.color_id = s.color_id
    WHERE (p.track_stock AND p.active AND $1::int IS NULL) OR s.supply_id = $1
    ORDER BY array_position(enum_range(NULL::product_category), p.category), p.name, col.label NULLS FIRST`, [one]);
  await labelPage(req, res, {
    title: one ? `Label for ${rows[0]?.name || ''}` : 'Supply shelf labels',
    back: one ? `/supplies/${one}` : '/supplies',
    labels: rows.map((s) => ({
      code: `S${s.supply_id}`, title: s.name,
      lines: [s.color, s.pack_size ? `${s.pack_size} per ${s.pricing_unit}` : '', s.location],
    })),
  });
});

router.get('/labels/tools', async (req, res) => {
  const one = Number(req.query.id) || null;
  const { rows } = await query(`SELECT * FROM tools WHERE ($1::int IS NULL AND status <> 'retired') OR tool_id = $1
    ORDER BY name, tag`, [one]);
  await labelPage(req, res, {
    title: one ? `Label for ${rows[0]?.name || ''}` : 'Tool labels',
    back: one ? `/tools/${one}` : '/tools',
    labels: rows.map((t) => ({
      code: `T${t.tool_id}`, big: t.tag ? `#${t.tag}` : '', title: t.name,
      lines: [t.serial_number ? `Serial ${t.serial_number}` : '', 'Property of High Plains Custom Metal', '(307) 331-6449'],
    })),
  });
});

// ---------------------------------------------------------------------------
// Pack and check: scan each line's label as its bundle is checked against the
// order. When every line is checked, the order can be marked Completed.
// ---------------------------------------------------------------------------
router.get('/orders/:id(\\d+)/pack', need('production'), async (req, res) => {
  const { rows: [o] } = await query(`SELECT o.*, c.display_name AS customer FROM orders o JOIN customers c USING (customer_id)
    WHERE o.order_id = $1`, [req.params.id]);
  if (!o) return res.status(404).send('Order not found');
  const lines = await orderLines(o.order_id);
  const done = lines.filter((l) => l.packed_at).length;
  const open = PACK_STATUSES.includes(o.status);
  const msg = req.query.ok ? html`<div class="notice pack-flash ok">✓ ${req.query.ok}</div>`
    : req.query.err ? html`<div class="alert pack-flash">✗ ${req.query.err}</div>` : '';
  res.send(layout({
    title: `Pack ${o.order_number}`, active: '/orders',
    body: html`
    <div class="page-head"><h1>Pack and check ${o.order_number}</h1>
      <div class="actions"><a class="btn" href="/labels/order/${o.order_id}">Print labels</a>
        <a class="btn" href="/orders/${o.order_id}">Back to the order</a></div></div>
    <p><strong>${o.customer}</strong>${o.job_name ? ` · ${o.job_name}` : ''}${o.need_by ? ` · need by ${date(o.need_by)}` : ''}
      · ${o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}</p>
    ${msg}
    ${open ? html`<form method="post" action="/orders/${o.order_id}/pack" class="card scan-big">
      <label>Scan a line label <input name="code" autofocus autocomplete="off" placeholder="Scan, or type a code like L123"></label>
      <button class="btn primary">Check</button>
    </form>` : html`<p class="muted">This order is ${o.status === 'quote' ? 'still a quote' : o.status}; packing is for approved orders that aren't completed yet.</p>`}
    <div class="pack-progress"><div style="width:${lines.length ? Math.round((100 * done) / lines.length) : 0}%"></div></div>
    <p><strong>${done} of ${lines.length}</strong> lines checked.</p>
    <table class="list pack">
      <thead><tr><th>Line</th><th>What to check</th><th>Color</th><th>Gauge</th><th>Checked</th><th></th></tr></thead>
      <tbody>${lines.map((l) => html`<tr class="${l.packed_at ? 'packed' : ''}">
        <td>${l.line_no}</td><td>${lineText(l)}</td><td>${l.color}</td><td>${l.gauge ? `${l.gauge} ga` : ''}</td>
        <td>${l.packed_at ? html`✓ ${l.packed_by} <span class="muted small">${new Date(l.packed_at).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>` : html`<span class="muted">Waiting</span>`}</td>
        <td class="num">${open ? html`<form method="post" action="/orders/${o.order_id}/pack" class="inline">
          <input type="hidden" name="code" value="L${l.order_item_id}">
          ${l.packed_at ? html`<input type="hidden" name="undo" value="1"><button class="btn small">Undo</button>`
          : html`<button class="btn small" title="For a bundle whose label is missing">Check without label</button>`}</form>` : ''}
          <a class="small" href="/labels/order/${o.order_id}?line=${l.order_item_id}">label</a></td></tr>`)}</tbody>
    </table>
    ${open && lines.length && done === lines.length && can('production') ? html`
    <form method="post" action="/orders/${o.order_id}/pack/complete" class="card pack-done">
      <strong>Everything is checked.</strong>
      <button class="btn primary">Mark order completed</button>
    </form>` : ''}`,
  }));
});

router.post('/orders/:id(\\d+)/pack', need('production'), async (req, res) => {
  const orderId = Number(req.params.id);
  const to = (k, m) => res.redirect(`/orders/${orderId}/pack?${k}=${encodeURIComponent(m)}`);
  const { rows: [o] } = await query('SELECT status, order_number FROM orders WHERE order_id = $1', [orderId]);
  if (!o) return res.status(404).send('Order not found');
  if (!PACK_STATUSES.includes(o.status)) return to('err', 'This order isn\'t open for packing.');
  const hit = await resolve(req.body.code);
  if (!hit) return to('err', `Nothing matches "${String(req.body.code || '').trim()}".`);
  if (hit.kind === 'order' && hit.id === orderId) return to('err', 'That\'s the whole-order label. Scan the label on each bundle.');
  if (hit.kind !== 'line') return to('err', 'That isn\'t an order line label.');
  if (hit.orderId !== orderId) {
    const { rows: [other] } = await query('SELECT order_number FROM orders WHERE order_id = $1', [hit.orderId]);
    return to('err', `WRONG ORDER: that bundle belongs to ${other.order_number}, not ${o.order_number}.`);
  }
  const lines = await orderLines(orderId);
  const line = lines.find((l) => l.order_item_id === hit.id);
  if (!line) return to('err', 'That line doesn\'t get packed.');
  if (req.body.undo) {
    await query('UPDATE order_items SET packed_at = NULL, packed_by = NULL WHERE order_item_id = $1', [line.order_item_id]);
    return to('ok', `Line ${line.line_no} unchecked.`);
  }
  if (line.packed_at) return to('err', `Line ${line.line_no} was already checked by ${line.packed_by}.`);
  await query('UPDATE order_items SET packed_at = now(), packed_by = $2 WHERE order_item_id = $1', [line.order_item_id, userName()]);
  const left = lines.filter((l) => !l.packed_at && l.order_item_id !== line.order_item_id).length;
  to('ok', `Line ${line.line_no}: ${lineText(line)}${line.color ? `, ${line.color}` : ''}. ${left ? `${left} to go.` : 'All lines checked.'}`);
});

router.post('/orders/:id(\\d+)/pack/complete', need('production'), async (req, res) => {
  const orderId = Number(req.params.id);
  const lines = await orderLines(orderId);
  const { rows: [o] } = await query('SELECT status, need_by FROM orders WHERE order_id = $1', [orderId]);
  if (!o || !PACK_STATUSES.includes(o.status)) return res.redirect(`/orders/${orderId}/pack`);
  if (!lines.length || lines.some((l) => !l.packed_at)) {
    return res.redirect(`/orders/${orderId}/pack?err=${encodeURIComponent('Some lines aren\'t checked yet.')}`);
  }
  const checkers = [...new Set(lines.map((l) => l.packed_by).filter(Boolean))].join(', ');
  await tx(async (db) => {
    await db.query(`UPDATE orders SET status = 'completed', completed_at = COALESCE(completed_at, now()),
        completed_by = COALESCE(completed_by, $2), inspected_by = COALESCE(inspected_by, $3), updated_by = $2
      WHERE order_id = $1`, [orderId, userName(), checkers]);
    await syncOrderSupplies(db, orderId, userName());
  });
  res.redirect(`/orders/${orderId}`);
});

module.exports = router;
module.exports.resolve = resolve;
