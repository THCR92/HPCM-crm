// Orders: one order = one cut sheet. Sections (Roof / Wall / Trim / Other)
// hold the cut-sheet rows; billable sq ft / LF are computed by the database.
const { query, tx } = require('../db');
const { feetInches } = require('../length');
const { RUNNABLE, footage, runError } = require('../production');
const {
  html, raw, layout, money, num, date, statusBadge, UNIT_LABEL, STATUS_LABEL, AREA_LABEL,
} = require('../html');

const router = require('../async-router')();

const EDITABLE = ['quote', 'confirmed', 'in_production', 'ready'];
// Statuses a person can pick. "invoiced" is set when the order goes to QuickBooks.
const SETTABLE = ['quote', 'confirmed', 'in_production', 'ready', 'completed', 'cancelled'];
const AREAS = ['roof', 'wall', 'trim', 'other'];

const TABS = {
  open: { label: 'Open', where: "o.status IN ('quote','confirmed','in_production','ready')" },
  quote: { label: 'Quotes', where: "o.status = 'quote'" },
  shop: { label: 'In the shop', where: "o.status IN ('confirmed','in_production','ready')" },
  completed: { label: 'Completed', where: "o.status IN ('completed','invoiced')" },
  all: { label: 'All', where: 'true' },
};

// Safe to drop into a <script> tag.
const jsonForScript = (v) => raw(JSON.stringify(v).replace(/</g, '\\u003c'));

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadOrder(id) {
  const { rows: [order] } = await query(`
    SELECT o.*, c.display_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
           t.lines_subtotal, t.taxable_subtotal, t.pre_tax_total
    FROM orders o JOIN customers c USING (customer_id) JOIN v_order_totals t USING (order_id)
    WHERE o.order_id = $1`, [id]);
  if (!order) return null;
  const { rows: sections } = await query(
    'SELECT * FROM order_sections WHERE order_id = $1 ORDER BY sort_order, section_id', [id]);
  const { rows: items } = await query(`
    SELECT oi.*, p.name AS product_name, p.sku, p.category, p.gauge_id AS product_gauge_id, p.girth_in AS product_girth_in,
           g.gauge, col.label AS color_name,
           fn_format_length(oi.length_in) AS length_display, ts.girth_in
    FROM order_items oi
    JOIN products p USING (product_id)
    LEFT JOIN gauges g ON g.gauge_id = p.gauge_id
    LEFT JOIN v_colors col ON col.color_id = oi.color_id
    LEFT JOIN order_item_trim_specs ts USING (order_item_id)
    WHERE oi.order_id = $1 ORDER BY oi.line_no`, [id]);
  for (const s of sections) s.items = items.filter((i) => i.section_id === s.section_id);
  const loose = items.filter((i) => !sections.some((s) => s.section_id === i.section_id));
  if (loose.length) sections.push({ section_id: null, area: 'other', label: null, items: loose });
  order.sections = sections;
  return order;
}

async function loadCatalog() {
  const { rows: products } = await query(`
    SELECT p.product_id AS id, p.name, p.category, p.pricing_unit AS unit, p.price_varies,
           p.is_cut_to_length, p.standard_length_in, p.max_length_in, cp.unit_price AS price,
           pp.coverage_width_in AS cov, pp.min_coverage_in AS cov_min, pp.max_coverage_in AS cov_max
    FROM products p
    LEFT JOIN v_current_prices cp USING (product_id)
    LEFT JOIN panel_profiles pp USING (profile_id)
    WHERE p.active AND p.category <> 'delivery'
    ORDER BY array_position(enum_range(NULL::product_category), p.category), p.name`);
  const { rows: colors } = await query(`
    SELECT color_id AS id, name, label, supplier_name AS supplier, finish, finish_label, upcharge_pct AS upcharge
    FROM v_colors WHERE active ORDER BY supplier_name NULLS FIRST, name, finish_sort`);
  const { rows: customers } = await query(`
    SELECT customer_id AS id, display_name AS name, phone, email, default_fulfillment
    FROM customers WHERE active ORDER BY lower(display_name)`);
  return { products, colors, customers };
}

// ---------------------------------------------------------------------------
// Saving (JSON posted by public/order-form.js)
// ---------------------------------------------------------------------------
class UserError extends Error {}

const text = (v, max) => {
  if (typeof v !== 'string' || v.trim() === '') return null;
  if (max && v.trim().length > max) throw new UserError(`Text is too long (max ${max} characters).`);
  return v.trim();
};
const amount = (v, label) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UserError(`${label} must be zero or more.`);
  return Math.round(n * 100) / 100;
};
const blank = (v) => v === null || v === undefined || v === '';
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

function parseHeader(b) {
  const customerId = Number(b.customer_id);
  if (!Number.isInteger(customerId) || customerId <= 0) throw new UserError('Pick a customer.');
  return {
    customer_id: customerId,
    job_name: text(b.job_name),
    po_number: text(b.po_number),
    job_address_text: text(b.job_address_text),
    contact_phone: text(b.contact_phone),
    contact_email: text(b.contact_email),
    fulfillment: b.fulfillment === 'delivery' ? 'delivery' : 'pickup',
    need_by: isoDate(b.need_by),
    delivery_charge: amount(b.delivery_charge, 'Delivery charge'),
    discount_amount: amount(b.discount_amount, 'Discount'),
    deposit_amount: amount(b.deposit_amount, 'Deposit'),
    customer_memo: text(b.customer_memo, 1000),
    internal_notes: text(b.internal_notes, 4000),
    completed_by: text(b.completed_by),
    inspected_by: text(b.inspected_by),
  };
}

function parseSections(b, productsById) {
  if (!Array.isArray(b.sections)) throw new UserError('The order has no sections.');
  return b.sections.map((s, si) => {
    const area = AREAS.includes(s.area) ? s.area : 'other';
    const where = (n) => `${AREA_LABEL[area]}${s.label ? ` (${s.label})` : ''}, line ${n}`;
    const items = (Array.isArray(s.items) ? s.items : []).map((it, ii) => {
      const p = productsById.get(Number(it.product_id));
      if (!p) throw new UserError(`${where(ii + 1)}: pick a product.`);
      const pieces = Number(it.pieces);
      if (!(pieces > 0)) throw new UserError(`${where(ii + 1)}: quantity must be more than zero.`);
      const length = blank(it.length_in) ? null : Number(it.length_in);
      if (length !== null && !(length > 0)) throw new UserError(`${where(ii + 1)}: length must be more than zero.`);
      if (length !== null && p.max_length_in && length > p.max_length_in) {
        throw new UserError(`${where(ii + 1)}: ${p.name} can be at most ${p.max_length_in / 12}' long.`);
      }
      if (['sqft', 'lf'].includes(p.unit) && length === null) {
        throw new UserError(`${where(ii + 1)}: ${p.name} needs a length.`);
      }
      let width = blank(it.width_in) ? null : Number(it.width_in);
      if (p.category === 'custom_trim' && !(width > 0)) {
        throw new UserError(`${where(ii + 1)}: enter the girth (flat width in inches) for custom trim.`);
      }
      if (p.category !== 'panel' && p.category !== 'custom_trim') width = null;
      const price = blank(it.unit_price) ? null : Number(it.unit_price);
      if (price === null || !(price >= 0)) throw new UserError(`${where(ii + 1)}: ${p.name} needs a price.`);
      return {
        order_item_id: Number(it.order_item_id) || null,
        product: p,
        color_id: Number(it.color_id) || null,
        pieces,
        length_in: length,
        width_in: width,
        unit_price: price,
        description: text(it.description, 4000),
      };
    });
    return {
      section_id: Number(s.section_id) || null, area, label: text(s.label), sort_order: si + 1, items,
    };
  });
}

async function saveOrder(orderId, body) {
  const header = parseHeader(body);
  const { rows: prodRows } = await query(`
    SELECT product_id AS id, name, category, pricing_unit AS unit, taxable, max_length_in FROM products`);
  const productsById = new Map(prodRows.map((p) => [p.id, p]));
  const sections = parseSections(body, productsById);

  return tx(async (db) => {
    const cols = Object.keys(header);
    if (orderId) {
      const { rows: [cur] } = await db.query('SELECT status FROM orders WHERE order_id = $1 FOR UPDATE', [orderId]);
      if (!cur) throw new UserError('Order not found.');
      if (!EDITABLE.includes(cur.status)) {
        throw new UserError(`This order is ${STATUS_LABEL[cur.status].toLowerCase()} and can't be edited. Reopen it first.`);
      }
      await db.query(`UPDATE orders SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}
                      WHERE order_id = $${cols.length + 1}`, [...cols.map((c) => header[c]), orderId]);
    } else {
      const { rows: [o] } = await db.query(`
        INSERT INTO orders (${cols.join(', ')}, quote_expires_on)
        VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, current_date + 30)
        RETURNING order_id`, cols.map((c) => header[c]));
      orderId = o.order_id;
    }

    // Lines and sections are updated in place (not deleted and re-added) so
    // that production records pointing at a line stay attached to it.
    const keepItems = sections.flatMap((s) => s.items.map((i) => i.order_item_id)).filter(Boolean);
    const keepSections = sections.map((s) => s.section_id).filter(Boolean);
    try {
      await db.query('DELETE FROM order_items WHERE order_id = $1 AND NOT (order_item_id = ANY($2::bigint[]))',
        [orderId, keepItems]);
    } catch (err) {
      if (err.code === '23503') throw new UserError('A line you removed already has production logged against it, so it can\'t be deleted.');
      throw err;
    }
    await db.query('DELETE FROM order_sections WHERE order_id = $1 AND NOT (section_id = ANY($2::bigint[]))',
      [orderId, keepSections]);
    // Park existing line numbers out of the way so renumbering can't collide.
    await db.query('UPDATE order_items SET line_no = -line_no WHERE order_id = $1', [orderId]);

    let lineNo = 0;
    for (const s of sections) {
      let sectionId = s.section_id;
      if (sectionId) {
        const r = await db.query(`UPDATE order_sections SET area = $1, label = $2, sort_order = $3
                                  WHERE section_id = $4 AND order_id = $5`,
        [s.area, s.label, s.sort_order, sectionId, orderId]);
        if (!r.rowCount) sectionId = null;
      }
      if (!sectionId) {
        const { rows: [r] } = await db.query(`INSERT INTO order_sections (order_id, area, label, sort_order)
                                              VALUES ($1, $2, $3, $4) RETURNING section_id`,
        [orderId, s.area, s.label, s.sort_order]);
        sectionId = r.section_id;
      }
      for (const it of s.items) {
        lineNo += 1;
        const vals = [sectionId, lineNo, it.product.id, it.color_id, it.pieces, it.length_in,
          it.width_in, it.unit_price, it.description];
        let itemId = it.order_item_id;
        if (itemId) {
          const r = await db.query(`
            UPDATE order_items oi SET section_id = $1, line_no = $2, product_id = $3, color_id = $4,
                   pieces = $5, length_in = $6,
                   width_in = COALESCE($7, (SELECT pp.coverage_width_in FROM products p
                                            JOIN panel_profiles pp USING (profile_id)
                                            WHERE p.product_id = $3)),
                   unit_price = $8, description = $9,
                   pricing_unit = p.pricing_unit, taxable = p.taxable,
                   per_length_in = CASE WHEN p.pricing_unit = 'each' THEN p.standard_length_in END
            FROM products p
            WHERE p.product_id = $3 AND oi.order_item_id = $10 AND oi.order_id = $11`,
          [...vals, itemId, orderId]);
          if (!r.rowCount) itemId = null;
        }
        if (!itemId) {
          const { rows: [r] } = await db.query(`
            INSERT INTO order_items (order_id, section_id, line_no, product_id, color_id, pieces,
                                     length_in, width_in, unit_price, description)
            VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING order_item_id`, [...vals, orderId]);
          itemId = r.order_item_id;
        }
        if (it.product.category === 'custom_trim') {
          await db.query(`
            INSERT INTO order_item_trim_specs (order_item_id, girth_in) VALUES ($1, $2)
            ON CONFLICT (order_item_id) DO UPDATE SET girth_in = EXCLUDED.girth_in`, [itemId, it.width_in]);
        } else {
          await db.query('DELETE FROM order_item_trim_specs WHERE order_item_id = $1', [itemId]);
        }
      }
    }
    return orderId;
  });
}

const dbMessage = (err) => {
  if (err instanceof UserError) return err.message;
  if (err.code === 'P0001' || err.code === '23514') return err.message; // trigger / check messages
  return null;
};

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const tab = TABS[req.query.tab] ? req.query.tab : 'open';
  const q = (req.query.q || '').trim();
  const { rows } = await query(`
    SELECT o.order_id, o.order_number, o.job_name, o.po_number, o.status, o.ordered_on, o.need_by,
           o.fulfillment, c.display_name AS customer_name, t.pre_tax_total
    FROM orders o JOIN customers c USING (customer_id) JOIN v_order_totals t USING (order_id)
    WHERE ${TABS[tab].where}
      AND ($1 = '' OR o.order_number ILIKE '%' || $1 || '%' OR o.job_name ILIKE '%' || $1 || '%'
           OR o.po_number ILIKE '%' || $1 || '%' OR c.display_name ILIKE '%' || $1 || '%')
    ORDER BY o.need_by NULLS LAST, o.order_id DESC`, [q]);
  res.send(layout({
    title: 'Orders', active: '/orders',
    body: html`
    <div class="page-head">
      <h1>Orders</h1>
      <a class="btn primary" href="/orders/new">+ New order</a>
    </div>
    <div class="tabs">${Object.entries(TABS).map(([k, t]) =>
      html`<a href="?tab=${k}" class="${k === tab ? 'active' : ''}">${t.label}</a>`)}</div>
    <form class="search"><input type="hidden" name="tab" value="${tab}">
      <input name="q" value="${q}" placeholder="Search order #, job, PO or customer"><button class="btn">Search</button></form>
    <table class="list">
      <thead><tr><th>Order #</th><th>Customer</th><th>Job</th><th>PO</th><th>Status</th>
        <th>Need by</th><th></th><th class="num">Total (pre-tax)</th></tr></thead>
      <tbody>${rows.length ? rows.map((o) => html`
        <tr><td><a href="/orders/${o.order_id}">${o.order_number}</a></td><td>${o.customer_name}</td>
        <td>${o.job_name}</td><td>${o.po_number}</td><td>${statusBadge(o.status)}</td>
        <td>${date(o.need_by)}</td><td>${o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}</td>
        <td class="num">${money(o.pre_tax_total)}</td></tr>`)
      : html`<tr><td colspan="8" class="empty">No orders here.</td></tr>`}</tbody>
    </table>`,
  }));
});

function formPage(res, { title, order, catalog }) {
  res.send(layout({
    title, active: '/orders',
    body: html`
    <h1>${title}</h1>
    <div id="order-form" class="order-form"><p class="muted">Loading…</p></div>
    <script>window.ORDER_FORM = ${jsonForScript({ order, ...catalog })};</script>`,
    scripts: ['/order-form.js'],
  }));
}

router.get('/new', async (req, res) => {
  const catalog = await loadCatalog();
  const customerId = Number(req.query.customer_id) || null;
  const cust = catalog.customers.find((c) => c.id === customerId);
  formPage(res, {
    title: 'New order',
    catalog,
    order: {
      order_id: null,
      customer_id: customerId,
      fulfillment: cust ? cust.default_fulfillment : 'pickup',
      contact_phone: cust?.phone || null,
      contact_email: cust?.email || null,
      sections: [{ area: 'roof', items: [] }, { area: 'wall', items: [] }, { area: 'trim', items: [] }],
    },
  });
});

router.get('/:id(\\d+)/edit', async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  if (!EDITABLE.includes(order.status)) return res.redirect(`/orders/${order.order_id}`);
  // Colors since hidden from new orders still show on the lines that use them.
  const { rows: hidden } = await query(`
    SELECT color_id AS id, name, label, supplier_name AS supplier, finish, finish_label, upcharge_pct AS upcharge
    FROM v_colors WHERE NOT active
      AND color_id IN (SELECT color_id FROM order_items WHERE order_id = $1)`, [order.order_id]);
  order.hidden_colors = hidden;
  formPage(res, { title: `Edit order ${order.order_number}`, order, catalog: await loadCatalog() });
});

const saveHandler = (getId) => async (req, res) => {
  try {
    const id = await saveOrder(getId(req), req.body);
    res.json({ ok: true, redirect: `/orders/${id}` });
  } catch (err) {
    const msg = dbMessage(err);
    if (!msg) throw err;
    res.status(400).json({ ok: false, error: msg });
  }
};
router.post('/', saveHandler(() => null));
router.post('/:id(\\d+)', saveHandler((req) => Number(req.params.id)));

router.post('/:id(\\d+)/status', async (req, res) => {
  const status = req.body.status;
  if (!SETTABLE.includes(status)) return res.status(400).send('Unknown status');
  await query(`
    UPDATE orders SET status = $1::order_status,
           completed_at = CASE WHEN $1::order_status = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END,
           ready_at = CASE WHEN $1::order_status = 'ready' THEN COALESCE(ready_at, now())
                           WHEN $1::order_status IN ('quote', 'confirmed', 'in_production') THEN NULL
                           ELSE ready_at END
    WHERE order_id = $2 AND status <> 'invoiced'`, [status, req.params.id]);
  res.redirect(`/orders/${req.params.id}`);
});

router.get('/:id(\\d+)', async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o) return res.status(404).send('Order not found');
  const editable = EDITABLE.includes(o.status);

  const sizeCol = (i) => {
    if (i.pricing_unit === 'sqft' && i.width_in) {
      return `${num(i.width_in, 3)}" ${i.category === 'custom_trim' ? 'girth' : 'cov.'}`;
    }
    return '';
  };
  const sectionTotals = (items) => {
    const sq = items.filter((i) => i.pricing_unit === 'sqft').reduce((a, i) => a + i.billable_qty, 0);
    const lf = items.filter((i) => i.pricing_unit === 'lf').reduce((a, i) => a + i.billable_qty, 0);
    return [sq ? `${num(sq)} sq ft` : '', lf ? `${num(lf)} LF` : ''].filter(Boolean).join(' · ');
  };
  const nextStatuses = SETTABLE.filter((s) => s !== o.status);
  // Each-priced pieces cut to a length are billed in standard lengths: "7.2 × 10'".
  const billed = (i) => (i.pricing_unit === 'each' && i.per_length_in && i.length_in
    ? `${num(i.billable_qty)} × ${num(i.per_length_in / 12)}'` : `${num(i.billable_qty)} ${UNIT_LABEL[i.pricing_unit]}`);
  const production = await productionSection(o, req);

  res.send(layout({
    title: `Order ${o.order_number}`, active: '/orders',
    body: html`
    <div class="page-head no-print">
      <h1>Order ${o.order_number} ${statusBadge(o.status)}</h1>
      <div class="actions">
        ${editable ? html`<a class="btn primary" href="/orders/${o.order_id}/edit">Edit order</a>` : ''}
        <button class="btn" onclick="window.print()">Print cut sheet</button>
        ${o.status !== 'invoiced' ? html`
        <form method="post" action="/orders/${o.order_id}/status" class="inline">
          <select name="status">${nextStatuses.map((s) => html`<option value="${s}">${STATUS_LABEL[s]}</option>`)}</select>
          <button class="btn">Change status</button>
        </form>` : ''}
      </div>
    </div>

    <section class="sheet">
      <div class="sheet-head">
        <div class="sheet-brand"><img src="/logo.svg" alt="High Plains Custom Metal">
          805 E Fox Farm Rd Unit B · Cheyenne, WY 82007 · (307) 331-6449</div>
        <div class="sheet-no">Order <strong>${o.order_number}</strong><br>${STATUS_LABEL[o.status]}</div>
      </div>
      <dl class="sheet-fields">
        <dt>Contractor / Customer</dt><dd><a href="/customers/${o.customer_id}">${o.customer_name}</a></dd>
        <dt>Job name</dt><dd>${o.job_name}</dd>
        <dt>Project / PO #</dt><dd>${o.po_number}</dd>
        <dt>Need by</dt><dd>${date(o.need_by)}</dd>
        <dt>Job address</dt><dd>${o.job_address_text}</dd>
        <dt>${o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}</dt><dd>Ordered ${date(o.ordered_on)}</dd>
        <dt>Phone</dt><dd>${o.contact_phone || o.customer_phone}</dd>
        <dt>Email</dt><dd>${o.contact_email || o.customer_email}</dd>
      </dl>

      ${o.sections.map((s) => html`
      <h3 class="area">${AREA_LABEL[s.area]}${s.label ? `: ${s.label}` : ''}
        <span class="area-total">${sectionTotals(s.items)}</span></h3>
      <table class="lines">
        <thead><tr><th class="num">Qty</th><th>Length</th><th>Panel / profile</th><th>Gauge</th><th>Color</th>
          <th>Width</th><th class="num">Billed</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
        <tbody>${s.items.length ? s.items.map((i) => html`
          <tr><td class="num">${num(i.pieces)}</td><td>${i.length_display}</td>
          <td>${i.product_name}${i.description ? html`<div class="muted small">${i.description}</div>` : ''}</td>
          <td>${i.gauge || ''}</td><td>${i.color_name}</td><td>${sizeCol(i)}</td>
          <td class="num">${billed(i)}</td>
          <td class="num">${money(i.unit_price)}</td><td class="num">${money(i.line_total)}</td></tr>`)
        : html`<tr><td colspan="9" class="empty">Nothing in this section.</td></tr>`}</tbody>
      </table>`)}

      <div class="sheet-foot">
        <div>
          ${o.customer_memo ? html`<p><strong>Note to customer:</strong> ${o.customer_memo}</p>` : ''}
          ${o.internal_notes ? html`<p class="no-print"><strong>Shop notes:</strong> ${o.internal_notes}</p>` : ''}
          <table class="shop-use">
            <tr><th>Completed by</th><td>${o.completed_by}</td><th>Inspected by</th><td>${o.inspected_by}</td></tr>
            <tr><th>Invoice #</th><td>${o.qbo_doc_number}</td><th>Date</th><td>${date(o.completed_at)}</td></tr>
          </table>
        </div>
        <table class="totals">
          <tr><th>Materials</th><td>${money(o.lines_subtotal)}</td></tr>
          ${o.delivery_charge ? html`<tr><th>Delivery</th><td>${money(o.delivery_charge)}</td></tr>` : ''}
          ${o.discount_amount ? html`<tr><th>Discount</th><td>−${money(o.discount_amount)}</td></tr>` : ''}
          <tr class="grand"><th>Total before tax</th><td>${money(o.pre_tax_total)}</td></tr>
          ${o.deposit_amount ? html`<tr><th>Deposit received</th><td>${money(o.deposit_amount)}</td></tr>` : ''}
          <tr><td colspan="2" class="muted small">Sales tax is added on the QuickBooks invoice.</td></tr>
        </table>
      </div>
    </section>
    ${production}`,
    scripts: ['/production.js'],
  }));
});

// ---------------------------------------------------------------------------
// Production: which coils each line was run from
// ---------------------------------------------------------------------------
const NO_PRODUCTION = ['quote', 'cancelled'];

async function productionSection(o, req) {
  const items = o.sections.flatMap((s) => s.items.map((i) => ({ ...i, area: s.area })))
    .filter((i) => RUNNABLE.includes(i.category));
  if (!items.length) return '';
  const { rows: runs } = await query(`
    SELECT r.*, fn_format_length(r.length_in) AS length_display, oi.line_no, oi.color_id AS line_color_id,
           c.coil_tag, c.color_id AS coil_color_id, c.color_label AS coil_color, c.gauge AS coil_gauge
    FROM production_runs r
    JOIN order_items oi USING (order_item_id)
    JOIN v_coils c USING (coil_id)
    WHERE oi.order_id = $1 ORDER BY r.run_at, r.production_run_id`, [o.order_id]);
  const runPieces = (id) => runs.filter((r) => r.order_item_id === id).reduce((a, r) => a + r.pieces, 0);
  const canLog = !NO_PRODUCTION.includes(o.status) && o.status !== 'invoiced';
  const { rows: coils } = canLog ? await query(`
    SELECT coil_id, coil_tag, color_id, color_label, gauge_id, gauge, width_in, current_lf
    FROM v_coils WHERE status IN ('received','in_stock','on_machine')
    ORDER BY color_label, gauge, coil_tag`) : { rows: [] };
  const back = `/orders/${o.order_id}`;
  return html`
  <section class="no-print" id="production">
    <h2>Production</h2>
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    <table class="list">
      <thead><tr><th>Line</th><th>Run</th><th>Coil</th><th class="num">Used</th><th>By</th><th>When</th><th></th></tr></thead>
      <tbody>${runs.length ? runs.map((r) => html`<tr>
        <td>${r.line_no}</td><td>${r.pieces} × ${r.length_display}</td>
        <td><a href="/coils/${r.coil_id}">${r.coil_tag}</a> ${r.coil_color}
          ${r.coil_color_id !== r.line_color_id ? html`<span class="badge badge-cancelled">different color</span>` : ''}</td>
        <td class="num">${num(r.lf_used, 1)} LF${r.scrap_lf ? html` <span class="muted small">(${num(r.scrap_lf, 1)} scrap)</span>` : ''}</td>
        <td>${r.operator}</td><td>${date(r.run_at)}</td>
        <td class="num">${canLog ? html`<form method="post" action="/runs/${r.production_run_id}/undo" class="inline"
            onsubmit="return confirm('Undo this run? The footage goes back on the coil.')">
            <input type="hidden" name="back" value="${back}"><button class="btn small">Undo</button></form>` : ''}</td></tr>`)
      : html`<tr><td colspan="7" class="empty">Nothing has been run for this order yet.</td></tr>`}</tbody>
    </table>
    ${o.status === 'quote' ? html`<p class="muted">Confirm the order to start logging production.</p>` : ''}
    ${canLog ? html`
    <form method="post" action="/orders/${o.order_id}/runs" class="card form-grid run-form" style="margin-top:1rem">
      <label class="span2">Line *<select name="order_item_id" required>
        <option value="">Pick a line…</option>
        ${items.map((i) => html`<option value="${i.order_item_id}" data-pieces="${Math.max(0, i.pieces - runPieces(i.order_item_id))}"
            data-length="${i.length_in ?? i.per_length_in ?? ''}" data-girth="${(i.category === 'custom_trim' ? i.width_in : i.product_girth_in) ?? ''}" data-color="${i.color_id ?? ''}" data-gauge="${i.product_gauge_id ?? ''}"
>
          ${i.line_no}. ${AREA_LABEL[i.area]}: ${num(i.pieces)} × ${i.length_display || 'each'} ${i.product_name}${i.color_name ? `, ${i.color_name}` : ''}
          (${runPieces(i.order_item_id)} of ${num(i.pieces)} run)</option>`)}
      </select></label>
      <label class="span2">Coil *<select name="coil_id" required>
        <option value="">Pick a coil…</option>
        ${coils.map((c) => html`<option value="${c.coil_id}" data-color="${c.color_id}" data-gauge="${c.gauge_id}" data-width="${c.width_in}">
          ${c.coil_tag}: ${c.color_label}, ${c.gauge} ga, ${num(c.width_in, 3)}" (${num(c.current_lf, 0)} LF left)</option>`)}
      </select></label>
      <div class="span2 alert run-warning" hidden></div>
      <label>Pieces *<input name="pieces" type="number" min="1" step="1" required></label>
      <label>Length<span class="row"><input name="ft" inputmode="numeric" placeholder="ft"><span class="unit">'</span>
        <input name="inch" placeholder="in"><span class="unit">"</span></span></label>
      <label>Coil feet used<input name="lf_used" type="number" step="0.1" min="0"></label>
      <label>Of that, scrap (LF)<input name="scrap_lf" type="number" step="0.1" min="0" placeholder="0"></label>
      <label>By<input name="operator"></label>
      <label class="check run-confirm" hidden><input type="checkbox" name="confirm" value="1"> Use this coil anyway</label>
      <div class="span2 actions"><button class="btn primary">Log run</button></div>
      <p class="span2 muted small"><span class="run-across"></span> Coil feet used fills in as pieces × length
        (for trim with a flat width set, pieces that fit side by side across the coil share the same footage). Change it if more came off the coil,
        and put any wasted footage under scrap.</p>
    </form>` : ''}
  </section>`;
}

router.post('/:id(\\d+)/runs', async (req, res) => {
  const orderId = Number(req.params.id);
  const b = req.body;
  const back = (msg) => res.redirect(`/orders/${orderId}?error=${encodeURIComponent(msg)}#production`);
  const { rows: [line] } = await query(`
    SELECT oi.*, p.category, p.gauge_id AS product_gauge_id, p.girth_in AS product_girth_in, o.status, col.label AS color_label
    FROM order_items oi JOIN products p USING (product_id) JOIN orders o USING (order_id)
    LEFT JOIN v_colors col ON col.color_id = oi.color_id
    WHERE oi.order_item_id = $1 AND oi.order_id = $2`, [Number(b.order_item_id), orderId]);
  if (!line) return back('Pick a line.');
  if (NO_PRODUCTION.includes(line.status) || line.status === 'invoiced') return back('Production can\'t be logged on this order.');
  const { rows: [coil] } = await query('SELECT * FROM v_coils WHERE coil_id = $1', [Number(b.coil_id)]);
  if (!coil) return back('Pick a coil.');
  const pieces = Number(b.pieces);
  if (!(pieces > 0) || !Number.isInteger(pieces)) return back('Enter a whole number of pieces.');
  let len = feetInches(b.ft, b.inch);
  if (Number.isNaN(len)) return back('The length isn\'t readable. Use feet, then inches like 6 or 6 1/2.');
  len = len || line.length_in;
  if (!(len > 0)) return back('Enter the length that was cut.');

  // The same color name from another supplier, or another gauge, doesn't match.
  const problems = [];
  if (line.color_id && coil.color_id !== line.color_id) {
    problems.push(`the coil is ${coil.color_label} but the line is ${line.color_label}`);
  }
  if (line.product_gauge_id && coil.gauge_id !== line.product_gauge_id) {
    problems.push(`the coil is ${coil.gauge} ga but the product is a different gauge`);
  }
  if (problems.length && b.confirm !== '1') {
    return back(`Check the coil: ${problems.join(', and ')}. Tick "Use this coil anyway" if that's right.`);
  }

  const typed = Number(b.lf_used);
  const scrap = Number(b.scrap_lf) || 0;
  // Footage typed in already includes scrap; otherwise it's pieces x length plus scrap.
  const girth = line.category === 'custom_trim' ? line.width_in : line.product_girth_in;
  const used = typed > 0 ? typed : footage(pieces, len, { girth, coilWidth: coil.width_in }) + scrap;
  if (scrap > used) return back('Scrap can\'t be more than the coil feet used.');
  try {
    await tx(async (db) => {
      await db.query(`
        INSERT INTO production_runs (coil_id, order_item_id, pieces, length_in, lf_used, scrap_lf, operator)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [coil.coil_id, line.order_item_id, pieces, len, Math.round(used * 10) / 10, scrap,
        (b.operator || '').trim() || null]);
      await db.query(`UPDATE orders SET status = 'in_production' WHERE order_id = $1 AND status = 'confirmed'`, [orderId]);
    });
    res.redirect(`/orders/${orderId}#production`);
  } catch (err) {
    const msg = runError(err);
    if (!msg) throw err;
    back(msg);
  }
});

module.exports = router;
