// Barcode labels, the scan box, and pack-and-check.
//
// Every label carries a QR code holding a link like https://www.hpcmcrm.net/s/C12,
// so a phone camera opens the page straight away, and a 2D barcode scanner
// (which types what it reads) works in the scan box at the top of every page.
//   HP-10023  an order         L<id>  one line of an order (a bundle or bag)
//   C<id>     a coil           S<id>  a supply shelf (item and color)
//   T<id>     a tool           B<id>  one bundle of an order line
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
    r = await query('SELECT order_id, status FROM orders WHERE order_number = $1', [up.replace(/^HP-?/, 'HP-')]);
    // A finished order waiting to leave opens straight to pickup / delivery.
    if (r.rows[0]) {
      const { order_id: id, status } = r.rows[0];
      return { kind: 'order', id, path: status === 'ready' ? `/orders/${id}/handoff` : `/orders/${id}` };
    }
  }
  const k = up.match(/^([LCSTB])(\d+)$/);
  if (k) {
    const id = Number(k[2]);
    if (k[1] === 'L') {
      r = await query('SELECT order_id FROM order_items WHERE order_item_id = $1', [id]);
      if (r.rows[0]) return { kind: 'line', id, orderId: r.rows[0].order_id, path: `/orders/${r.rows[0].order_id}/pack` };
    }
    if (k[1] === 'B') {
      r = await query(`SELECT oi.order_id, b.order_item_id FROM order_bundles b JOIN order_items oi USING (order_item_id)
        WHERE b.bundle_id = $1`, [id]);
      if (r.rows[0]) return { kind: 'bundle', id, lineId: r.rows[0].order_item_id, orderId: r.rows[0].order_id, path: `/orders/${r.rows[0].order_id}/pack` };
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


// Split a line's pieces into bundles: 26 at 10 per bundle = 10 + 10 + 6.
function split(pieces, size) {
  const n = Number(pieces);
  if (!size || size >= n) return [n];
  const out = [];
  for (let left = n; left > 0; left -= size) out.push(Math.min(size, Math.round(left * 100) / 100));
  return out;
}

// Every packable line gets bundles the first time labels or the pack page are opened.
async function ensureBundles(orderId) {
  await tx(async (db) => {
    const { rows } = await db.query(`
      SELECT oi.order_item_id, oi.pieces, p.bundle_size FROM order_items oi JOIN products p USING (product_id)
      WHERE oi.order_id = $1 AND ${PACKABLE}
        AND NOT EXISTS (SELECT 1 FROM order_bundles b WHERE b.order_item_id = oi.order_item_id)
      FOR UPDATE OF oi`, [orderId]);
    for (const r of rows) {
      for (const [i, pcs] of split(r.pieces, r.bundle_size).entries()) {
        await db.query(`INSERT INTO order_bundles (order_item_id, seq, pieces) VALUES ($1, $2, $3)
          ON CONFLICT (order_item_id, seq) DO NOTHING`, [r.order_item_id, i + 1, pcs]);
      }
    }
  });
}

async function orderLines(orderId) {
  await ensureBundles(orderId);
  const { rows } = await query(`
    SELECT oi.order_item_id, oi.line_no, oi.pieces, oi.pricing_unit, oi.width_in, oi.packed_at, oi.packed_by,
           fn_format_length(oi.length_in) AS length_display, p.name AS product_name, p.category, p.bundle_size,
           col.label AS color, g.gauge, os.area, os.label AS section_label, COALESCE(os.sort_order, 999) AS section_sort
    FROM order_items oi JOIN products p USING (product_id)
    LEFT JOIN v_colors col ON col.color_id = oi.color_id
    LEFT JOIN gauges g ON g.gauge_id = p.gauge_id
    LEFT JOIN order_sections os ON os.section_id = oi.section_id
    WHERE oi.order_id = $1 AND ${PACKABLE}
    ORDER BY section_sort, os.section_id, oi.line_no`, [orderId]);
  const { rows: bundles } = await query(`
    SELECT b.* FROM order_bundles b JOIN order_items oi USING (order_item_id)
    WHERE oi.order_id = $1 ORDER BY b.order_item_id, b.seq`, [orderId]);
  for (const l of rows) l.bundles = bundles.filter((b) => b.order_item_id === l.order_item_id);
  return rows;
}

const AREA = { roof: 'Roof', wall: 'Wall', trim: 'Trim', other: 'Other' };
const bundleText = (l, b) => {
  const len = l.length_display ? ` × ${l.length_display}` : '';
  return `${num(b.pieces)}${len} ${l.product_name}`;
};

router.get('/labels/order/:id(\\d+)', async (req, res) => {
  const { rows: [o] } = await query(`SELECT o.*, c.display_name AS customer FROM orders o JOIN customers c USING (customer_id)
    WHERE o.order_id = $1`, [req.params.id]);
  if (!o) return res.status(404).send('Order not found');
  const lines = await orderLines(o.order_id);
  const total = lines.reduce((a, l) => a + l.bundles.length, 0);
  const head = [o.customer, o.job_name, o.need_by ? `Need by ${date(o.need_by)}` : '', o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'];
  const labels = [];
  const onlyLine = Number(req.query.line) || null;
  const onlyBundle = Number(req.query.bundle) || null;
  if (!onlyLine && !onlyBundle) {
    labels.push({ code: o.order_number, big: o.order_number, title: 'Whole order',
      lines: [...head, `${lines.length} line${lines.length === 1 ? '' : 's'}, ${total} bundle${total === 1 ? '' : 's'}`] });
  }
  for (const l of lines) {
    if (onlyLine && l.order_item_id !== onlyLine) continue;
    for (const b of l.bundles) {
      if (onlyBundle && b.bundle_id !== onlyBundle) continue;
      labels.push({
        code: `B${b.bundle_id}`, big: o.order_number, title: bundleText(l, b),
        lines: [[l.color, l.gauge ? `${l.gauge} ga` : ''].filter(Boolean).join(' · '),
          `${o.customer}${o.job_name ? ` · ${o.job_name}` : ''}`,
          `${l.section_label || AREA[l.area] || ''}${l.section_label || l.area ? ' · ' : ''}line ${l.line_no}${
            l.bundles.length > 1 ? ` · bundle ${b.seq} of ${l.bundles.length}` : ''}`],
      });
    }
  }
  await labelPage(req, res, { title: `Labels for ${o.order_number}`, labels, back: `/orders/${o.order_id}/pack` });
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

// ---------------------------------------------------------------------------
// Pack and check: count each line into bundles, print a label per bundle, and
// scan each bundle as it's checked against the order. When every bundle is
// checked, the order can be marked Completed.
// ---------------------------------------------------------------------------
const stamp = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

router.get('/orders/:id(\\d+)/pack', need('production'), async (req, res) => {
  const { rows: [o] } = await query(`SELECT o.*, c.display_name AS customer FROM orders o JOIN customers c USING (customer_id)
    WHERE o.order_id = $1`, [req.params.id]);
  if (!o) return res.status(404).send('Order not found');
  const lines = await orderLines(o.order_id);
  const bundles = lines.flatMap((l) => l.bundles);
  const done = bundles.filter((b) => b.packed_at).length;
  const open = PACK_STATUSES.includes(o.status);
  const msg = req.query.ok ? html`<div class="notice pack-flash ok">✓ ${req.query.ok}</div>`
    : req.query.err ? html`<div class="alert pack-flash">✗ ${req.query.err}</div>` : '';
  const act = (code, label, extra = '') => html`<form method="post" action="/orders/${o.order_id}/pack" class="inline">
    <input type="hidden" name="code" value="${code}">${extra ? raw(extra) : ''}<button class="btn small">${label}</button></form>`;
  res.send(layout({
    title: `Pack ${o.order_number}`, active: '/orders',
    body: html`
    <div class="page-head"><h1>Pack and check ${o.order_number}</h1>
      <div class="actions"><a class="btn primary" href="/labels/order/${o.order_id}">Print all labels</a>
        <a class="btn" href="/orders/${o.order_id}">Back to the order</a></div></div>
    <p><strong>${o.customer}</strong>${o.job_name ? ` · ${o.job_name}` : ''}${o.need_by ? ` · need by ${date(o.need_by)}` : ''}
      · ${o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}</p>
    <p class="muted small">1. Count each line into bundles: type how many go in a bundle (10 makes 26 pieces 10 + 10 + 6), or each
      bundle's count (13, 13). The CRM remembers the bundle size for that item next time.
      2. Print the labels and stick one on each bundle. 3. Scan each bundle as you check it against the line.</p>
    ${msg}
    ${open ? html`<form method="post" action="/orders/${o.order_id}/pack" class="card scan-big">
      <label>Scan a bundle label <input name="code" autofocus autocomplete="off" placeholder="Scan, or type a code like B123"></label>
      <button class="btn primary">Check</button>
    </form>` : html`<p class="muted">This order is ${o.status === 'quote' ? 'still a quote' : o.status}; packing is for approved orders that aren't completed yet.</p>`}
    <div class="pack-progress"><div style="width:${bundles.length ? Math.round((100 * done) / bundles.length) : 0}%"></div></div>
    <p><strong>${done} of ${bundles.length}</strong> bundles checked.</p>
    <table class="list pack">
      <thead><tr><th>Line</th><th>What to check</th><th>Color</th><th>Gauge</th><th>Checked</th><th></th></tr></thead>
      ${lines.map((l) => {
        const anyPacked = l.bundles.some((b) => b.packed_at);
        return html`<tbody class="pack-line">
        <tr class="line-head ${l.bundles.every((b) => b.packed_at) ? 'packed' : ''}">
          <td>${l.line_no}</td><td><strong>${lineText(l)}</strong></td><td>${l.color}</td><td>${l.gauge ? `${l.gauge} ga` : ''}</td>
          <td colspan="2">${open && !anyPacked ? html`<form method="post" action="/orders/${o.order_id}/pack/bundles" class="inline bundle-split">
              <input type="hidden" name="order_item_id" value="${l.order_item_id}">
              <label title="One number = that many per bundle (10 → 10 + 10 + 6). Several = each bundle (13, 13).">Bundles
                <input name="split" value="${l.bundles.map((b) => num(b.pieces)).join(', ')}" size="12"></label>
              <button class="btn small">Change</button></form>`
            : html`<span class="muted small">${l.bundles.length} bundle${l.bundles.length === 1 ? '' : 's'}: ${l.bundles.map((b) => num(b.pieces)).join(' + ')}</span>`}
            <a class="small" href="/labels/order/${o.order_id}?line=${l.order_item_id}">labels</a></td>
        </tr>
        ${l.bundles.map((b) => html`<tr class="bundle ${b.packed_at ? 'packed' : ''}">
          <td></td><td>Bundle ${b.seq}${l.bundles.length > 1 ? ` of ${l.bundles.length}` : ''}: ${bundleText(l, b)}</td><td></td><td></td>
          <td>${b.packed_at ? html`✓ ${b.packed_by} <span class="muted small">${stamp(b.packed_at)}</span>` : html`<span class="muted">Waiting</span>`}</td>
          <td class="num">${open ? (b.packed_at ? act(`B${b.bundle_id}`, 'Undo', '<input type="hidden" name="undo" value="1">')
            : act(`B${b.bundle_id}`, 'Check without label')) : ''}
            <a class="small" href="/labels/order/${o.order_id}?bundle=${b.bundle_id}">label</a></td></tr>`)}
        </tbody>`;
      })}
    </table>
    ${open && bundles.length && done === bundles.length ? (o.status === 'ready' ? html`
    <div class="card pack-done"><strong>Everything is checked and the order is ready to leave.</strong>
      <a class="btn primary" href="/orders/${o.order_id}/handoff">${o.fulfillment === 'delivery' ? 'Delivered' : 'Picked up'}…</a></div>` : html`
    <form method="post" action="/orders/${o.order_id}/pack/complete" class="card pack-done">
      <strong>Everything is checked.</strong>
      <button class="btn primary">Mark ready for ${o.fulfillment === 'delivery' ? 'delivery' : 'pickup'}</button>
    </form>`) : ''}`,
  }));
});

// Change how a line is split into bundles ("10, 10, 6"). Only before any of them is checked.
router.post('/orders/:id(\\d+)/pack/bundles', need('production'), async (req, res) => {
  const orderId = Number(req.params.id);
  const to = (k, m) => res.redirect(`/orders/${orderId}/pack?${k}=${encodeURIComponent(m)}`);
  const lines = await orderLines(orderId);
  const l = lines.find((x) => x.order_item_id === Number(req.body.order_item_id));
  if (!l) return to('err', 'That line isn\'t on this order.');
  if (l.bundles.some((b) => b.packed_at)) return to('err', `Line ${l.line_no} already has checked bundles. Undo them first.`);
  const parts = String(req.body.split || '').split(/[\s,+]+/).filter(Boolean).map(Number);
  if (!parts.length || parts.some((n) => !(n > 0))) return to('err', 'Enter the pieces in each bundle, like 10, 10, 6.');
  // One number smaller than the line: that many per bundle, remembered for this item.
  let perBundle = null;
  if (parts.length === 1 && parts[0] < Number(l.pieces)) {
    perBundle = Math.round(parts[0]);
    if (perBundle < 1) return to('err', 'A bundle needs at least 1 piece.');
    parts.splice(0, 1, ...split(l.pieces, perBundle));
  }
  const sum = Math.round(parts.reduce((a, n) => a + n, 0) * 100) / 100;
  if (sum !== Number(l.pieces)) return to('err', `Line ${l.line_no} has ${num(l.pieces)} pieces, but those bundles add up to ${num(sum)}.`);
  await tx(async (db) => {
    await db.query('DELETE FROM order_bundles WHERE order_item_id = $1', [l.order_item_id]);
    for (const [i, n] of parts.entries()) {
      await db.query('INSERT INTO order_bundles (order_item_id, seq, pieces) VALUES ($1, $2, $3)', [l.order_item_id, i + 1, n]);
    }
    if (perBundle) {
      await db.query(`UPDATE products SET bundle_size = $2 FROM order_items oi
        WHERE oi.order_item_id = $1 AND products.product_id = oi.product_id`, [l.order_item_id, perBundle]);
    }
  });
  to('ok', `Line ${l.line_no} is now ${parts.length} bundle${parts.length === 1 ? '' : 's'}: ${parts.join(' + ')}. Print its labels again.${perBundle ? ` ${perBundle} per bundle is now the usual for ${l.product_name}.` : ''}`);
});

router.post('/orders/:id(\\d+)/pack', need('production'), async (req, res) => {
  const orderId = Number(req.params.id);
  const to = (k, m) => res.redirect(`/orders/${orderId}/pack?${k}=${encodeURIComponent(m)}`);
  const { rows: [o] } = await query('SELECT status, order_number FROM orders WHERE order_id = $1', [orderId]);
  if (!o) return res.status(404).send('Order not found');
  if (!PACK_STATUSES.includes(o.status)) return to('err', 'This order isn\'t open for packing.');
  const code = String(req.body.code || '').trim();
  const hit = await resolve(code);
  if (!hit) return to('err', `Nothing matches "${code}". If its line was re-bundled, print its labels again.`);
  if (hit.kind === 'order' && hit.id === orderId) return to('err', 'That\'s the whole-order label. Scan the label on each bundle.');
  if (hit.kind !== 'line' && hit.kind !== 'bundle') return to('err', 'That isn\'t a bundle label.');
  if (hit.orderId !== orderId) {
    const { rows: [other] } = await query('SELECT order_number FROM orders WHERE order_id = $1', [hit.orderId]);
    return to('err', `WRONG ORDER: that bundle belongs to ${other.order_number}, not ${o.order_number}.`);
  }
  const lines = await orderLines(orderId);
  const line = lines.find((l) => l.order_item_id === (hit.kind === 'bundle' ? hit.lineId : hit.id));
  if (!line) return to('err', 'That line doesn\'t get packed.');
  let bundle;
  if (hit.kind === 'bundle') bundle = line.bundles.find((b) => b.bundle_id === hit.id);
  else if (line.bundles.length === 1) [bundle] = line.bundles;
  else return to('err', `Line ${line.line_no} is in ${line.bundles.length} bundles. Scan the bundle labels.`);
  const where = `Line ${line.line_no}${line.bundles.length > 1 ? `, bundle ${bundle.seq} of ${line.bundles.length}` : ''}`;
  if (req.body.undo) {
    await tx(async (db) => {
      await db.query('UPDATE order_bundles SET packed_at = NULL, packed_by = NULL WHERE bundle_id = $1', [bundle.bundle_id]);
      await db.query('UPDATE order_items SET packed_at = NULL, packed_by = NULL WHERE order_item_id = $1', [line.order_item_id]);
    });
    return to('ok', `${where} unchecked.`);
  }
  if (bundle.packed_at) return to('err', `${where} was already checked by ${bundle.packed_by}.`);
  await tx(async (db) => {
    await db.query('UPDATE order_bundles SET packed_at = now(), packed_by = $2 WHERE bundle_id = $1', [bundle.bundle_id, userName()]);
    // The line is checked once all its bundles are.
    await db.query(`UPDATE order_items SET packed_at = now(), packed_by = $2 WHERE order_item_id = $1
      AND NOT EXISTS (SELECT 1 FROM order_bundles WHERE order_item_id = $1 AND packed_at IS NULL)`, [line.order_item_id, userName()]);
  });
  const left = lines.flatMap((l) => l.bundles).filter((b) => !b.packed_at && b.bundle_id !== bundle.bundle_id).length;
  to('ok', `${where}: ${bundleText(line, bundle)}${line.color ? `, ${line.color}` : ''}. ${left ? `${left} to go.` : 'All bundles checked.'}`);
});

router.post('/orders/:id(\\d+)/pack/complete', need('production'), async (req, res) => {
  const orderId = Number(req.params.id);
  const lines = await orderLines(orderId);
  const bundles = lines.flatMap((l) => l.bundles);
  const { rows: [o] } = await query('SELECT status FROM orders WHERE order_id = $1', [orderId]);
  if (!o || !PACK_STATUSES.includes(o.status)) return res.redirect(`/orders/${orderId}/pack`);
  if (!bundles.length || bundles.some((b) => !b.packed_at)) {
    return res.redirect(`/orders/${orderId}/pack?err=${encodeURIComponent('Some bundles aren\'t checked yet.')}`);
  }
  // Checked and packed: ready to leave. Scanning the whole-order label at
  // pickup or delivery completes it.
  const checkers = [...new Set(bundles.map((b) => b.packed_by).filter(Boolean))].join(', ');
  await query(`UPDATE orders SET status = 'ready', ready_at = COALESCE(ready_at, now()),
      inspected_by = COALESCE(inspected_by, $3), updated_by = $2
    WHERE order_id = $1`, [orderId, userName(), checkers]);
  res.redirect(`/orders/${orderId}/pack`);
});

// ---------------------------------------------------------------------------
// Pickup and delivery: scan the whole-order label as it leaves the shop.
// ---------------------------------------------------------------------------
const HANDOFF_FROM = ['confirmed', 'in_production', 'ready'];
const canHandoff = () => can('production') || can('quotes');

router.get('/orders/:id(\\d+)/handoff', async (req, res) => {
  if (!canHandoff()) return res.status(403).send('Not allowed');
  const { rows: [o] } = await query(`SELECT o.*, c.display_name AS customer, c.phone AS customer_phone
    FROM orders o JOIN customers c USING (customer_id) WHERE o.order_id = $1`, [req.params.id]);
  if (!o) return res.status(404).send('Order not found');
  const lines = await orderLines(o.order_id);
  const bundles = lines.flatMap((l) => l.bundles);
  const unchecked = bundles.filter((b) => !b.packed_at).length;
  const { rows: tools } = await query(`
    SELECT oi.order_item_id, p.name, EXISTS (SELECT 1 FROM tool_rentals r WHERE r.order_item_id = oi.order_item_id) AS out
    FROM order_items oi JOIN products p USING (product_id) WHERE oi.order_id = $1 AND p.is_rental`, [o.order_id]);
  const toolsNotOut = tools.filter((t) => !t.out);
  const method = o.fulfillment === 'delivery' ? 'delivery' : 'pickup';
  const open = HANDOFF_FROM.includes(o.status);
  res.send(layout({
    title: `${method === 'delivery' ? 'Deliver' : 'Pick up'} ${o.order_number}`, active: '/orders',
    body: html`
    <div class="page-head"><h1>${method === 'delivery' ? 'Delivery' : 'Pickup'}: ${o.order_number}</h1>
      <a class="btn" href="/orders/${o.order_id}">Back to the order</a></div>
    ${req.query.err ? html`<div class="alert">${req.query.err}</div>` : ''}
    <div class="card handoff">
      <div class="big-name">${o.customer}</div>
      <p>${o.job_name ? html`${o.job_name} · ` : ''}${o.customer_phone}${o.need_by ? html` · need by ${date(o.need_by)}` : ''}</p>
      <p><strong>${bundles.length} bundle${bundles.length === 1 ? '' : 's'}</strong> on ${lines.length} line${lines.length === 1 ? '' : 's'}:
        ${lines.map((l) => `${lineText(l)}${l.color ? ` (${l.color})` : ''}`).join('; ')}</p>
      ${o.handed_off_at ? html`<div class="notice">Already ${o.handoff_method === 'delivery' ? 'delivered' : 'picked up'}
        ${new Date(o.handed_off_at).toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'medium', timeStyle: 'short' })}
        by ${o.handed_off_by}${o.received_by ? `, received by ${o.received_by}` : ''}.</div>` : ''}
      ${unchecked && open ? html`<div class="alert">${unchecked} bundle${unchecked === 1 ? ' hasn\'t' : 's haven\'t'} been checked in
        <a href="/orders/${o.order_id}/pack">Pack &amp; check</a>.</div>` : ''}
      ${toolsNotOut.length && open ? html`<div class="alert">Rental tools not checked out yet: ${toolsNotOut.map((t) => t.name).join(', ')}.
        <a href="/orders/${o.order_id}#rentals">Check them out</a> before it leaves.</div>` : ''}
      ${open ? html`<form method="post" action="/orders/${o.order_id}/handoff" class="form-grid" style="margin-top:1rem">
        <label>How<select name="method">
          <option value="pickup" ${method === 'pickup' ? 'selected' : ''}>Picked up</option>
          <option value="delivery" ${method === 'delivery' ? 'selected' : ''}>Delivered</option></select></label>
        <label>Received by<input name="received_by" placeholder="Name of the person who took it" autofocus></label>
        <label class="span2">Note<input name="note" placeholder="Truck, trailer, anything missing…"></label>
        ${unchecked ? html`<label class="check span2"><input type="checkbox" name="skip_check" value="1"> Send it without every bundle checked</label>` : ''}
        <div class="span2 actions"><button class="btn primary big-btn">${method === 'delivery' ? 'Mark delivered' : 'Mark picked up'}</button></div>
      </form>` : html`<p class="muted">This order is ${o.status}.</p>`}
    </div>`,
  }));
});

router.post('/orders/:id(\\d+)/handoff', async (req, res) => {
  if (!canHandoff()) return res.status(403).send('Not allowed');
  const orderId = Number(req.params.id);
  const back = (err) => res.redirect(`/orders/${orderId}/handoff?err=${encodeURIComponent(err)}`);
  const { rows: [o] } = await query('SELECT status FROM orders WHERE order_id = $1', [orderId]);
  if (!o) return res.status(404).send('Order not found');
  if (!HANDOFF_FROM.includes(o.status)) return back(`This order is ${o.status}.`);
  const bundles = (await orderLines(orderId)).flatMap((l) => l.bundles);
  if (bundles.some((b) => !b.packed_at) && req.body.skip_check !== '1') {
    return back('Some bundles haven\'t been checked. Check them, or tick "Send it without every bundle checked".');
  }
  const method = req.body.method === 'delivery' ? 'delivery' : 'pickup';
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  await tx(async (db) => {
    await db.query(`UPDATE orders SET status = 'completed', completed_at = COALESCE(completed_at, now()),
        completed_by = COALESCE(completed_by, $2), handed_off_at = now(), handed_off_by = $2, handoff_method = $3,
        received_by = $4, handoff_note = $5, updated_by = $2,
        delivered_on = (now() AT TIME ZONE 'America/Denver')::date
      WHERE order_id = $1`, [orderId, userName(), method, clean(req.body.received_by), clean(req.body.note)]);
    await syncOrderSupplies(db, orderId, userName());
  });
  res.redirect(`/orders/${orderId}`);
});

module.exports = router;
module.exports.resolve = resolve;
