// Supplies (boots, jacks, screws, accessories: anything on the price list marked
// "count on hand") and tools (shop tools, some rented out on quotes).
const { query, tx } = require('../db');
const { html, layout, money, num, date } = require('../html');
const { can, need, userName } = require('../auth');
const { supplyRow, LINE_QTY } = require('../supplies');

const router = require('../async-router')();

const TZ = 'America/Denver';
const HEADINGS = { boot: 'Boots', jack: 'Jacks', fastener: 'Screws', accessory: 'Accessories' };
const UNIT_WORD = { each: '', bag: 'bags', roll: 'rolls', lf: 'ft', sqft: 'sq ft' };
const TXN_LABEL = { receive: 'Received', order: 'Order', count: 'Counted', adjust: 'Used or damaged' };
const TOOL_STATUS = { available: 'Available', repair: 'In for repair', retired: 'Retired' };

const back = (res, path, error) =>
  res.redirect(`${path}${error ? `${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(error)}` : ''}`);
const alert = (req) => html`${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}${
  req.query.saved ? html`<div class="notice">Saved.</div>` : ''}`;
const qty = (n, unit) => (n === null || n === undefined ? '' : `${num(n)}${UNIT_WORD[unit] ? ` ${UNIT_WORD[unit]}` : ''}`);
const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const optNum = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : Number(v));

// On open orders: tracked lines on approved orders not completed yet.
const COMMITTED = `
  SELECT oi.product_id, CASE WHEN p.stock_by_color THEN oi.color_id END AS color_id, sum(${LINE_QTY}) AS qty
  FROM order_items oi JOIN products p USING (product_id) JOIN orders o USING (order_id)
  WHERE p.track_stock AND o.status IN ('confirmed', 'in_production', 'ready')
  GROUP BY 1, 2`;

// ---------------------------------------------------------------------------
// Supplies
// ---------------------------------------------------------------------------
router.get('/supplies', async (req, res) => {
  const lowOnly = req.query.show === 'low';
  const { rows } = await query(`
    WITH committed AS (${COMMITTED})
    SELECT p.product_id, p.name, p.category, p.pricing_unit, p.stock_by_color, p.pack_size,
           s.supply_id, s.color_id, col.label AS color, COALESCE(s.qty_on_hand, 0) AS on_hand,
           COALESCE(c.qty, 0) AS committed, COALESCE(s.qty_on_hand, 0) - COALESCE(c.qty, 0) AS available,
           s.reorder_at, s.location, s.avg_cost, COALESCE(s.qty_on_hand, 0) * s.avg_cost AS value
    FROM products p
    LEFT JOIN supply_stock s USING (product_id)
    LEFT JOIN v_colors col ON col.color_id = s.color_id
    LEFT JOIN committed c ON c.product_id = p.product_id AND c.color_id IS NOT DISTINCT FROM s.color_id
    WHERE p.track_stock AND p.active
    ORDER BY array_position(enum_range(NULL::product_category), p.category), p.name, col.label NULLS FIRST`);
  // Colors on open orders that nobody has counted yet show up too.
  const { rows: uncounted } = await query(`
    WITH committed AS (${COMMITTED})
    SELECT p.product_id, p.name, p.category, p.pricing_unit, p.stock_by_color, NULL::int AS supply_id,
           c.color_id, col.label AS color, 0 AS on_hand, c.qty AS committed, -c.qty AS available,
           NULL::numeric AS reorder_at, NULL AS location, NULL::numeric AS avg_cost, NULL::numeric AS value
    FROM committed c JOIN products p USING (product_id) LEFT JOIN v_colors col ON col.color_id = c.color_id
    WHERE p.active AND p.stock_by_color AND NOT EXISTS (SELECT 1 FROM supply_stock s
      WHERE s.product_id = c.product_id AND s.color_id IS NOT DISTINCT FROM c.color_id)`);
  const all = rows.filter((r) => r.supply_id || !r.stock_by_color).concat(uncounted)
    .sort((a, b) => (Object.keys(HEADINGS).indexOf(a.category) - Object.keys(HEADINGS).indexOf(b.category))
      || a.name.localeCompare(b.name) || String(a.color || '').localeCompare(String(b.color || '')));
  const noColorsYet = rows.filter((r) => r.stock_by_color && !r.supply_id && !uncounted.some((u) => u.product_id === r.product_id));
  const low = (r) => r.available < 0 || (r.reorder_at !== null && r.available <= r.reorder_at);
  const shown = lowOnly ? all.filter(low) : all;
  const groups = new Map();
  for (const r of shown) {
    const h = HEADINGS[r.category] || 'Other';
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(r);
  }
  const { rows: products } = await query(`
    SELECT product_id, name, category, stock_by_color FROM products WHERE track_stock AND active
    ORDER BY array_position(enum_range(NULL::product_category), category), name`);
  const { rows: colors } = await query(`SELECT color_id, label FROM v_colors WHERE active ORDER BY supplier_name NULLS FIRST, name, finish_sort`);
  const lowCount = all.filter(low).length;
  const prices = can('prices');
  const totalValue = all.reduce((a, r) => a + (r.value > 0 ? r.value : 0), 0);
  const noCost = all.filter((r) => r.on_hand > 0 && r.avg_cost === null).length;

  res.send(layout({
    title: 'Supplies', active: '/supplies',
    body: html`
    <div class="page-head"><h1>Supplies</h1>
      <div class="actions">
        <a class="btn ${lowOnly ? '' : 'primary'}" href="/supplies">Everything</a>
        <a class="btn ${lowOnly ? 'primary' : ''}" href="/supplies?show=low">Running low (${lowCount})</a>
      </div></div>
    <p class="muted">Boots, jacks, screws and accessories. Supplies on an order come out of stock when the order is
      marked Completed, and go back if it's reopened. "On orders" is what approved orders still need. Screws are counted
      by color. To count something else (caulking, sealant), tick "Count on hand" on the product in Admin &gt; Products.</p>
    ${alert(req)}
    <div class="rtiles" style="margin-bottom:1rem">
      ${prices ? html`<div class="rtile"><div class="n">${money(totalValue)}</div><div class="label">Value on hand</div>
        <div class="sub">at your average cost${noCost ? html`; <span class="low-text">${noCost} item${noCost === 1 ? '' : 's'} on hand with no cost yet</span>` : ''}</div></div>` : ''}
      <div class="rtile ${lowCount ? 'warn' : ''}"><div class="n">${lowCount}</div><div class="label">Running low or short</div></div>
    </div>
    ${can('inventory') ? html`<details class="card" ${all.some((r) => r.on_hand) ? '' : 'open'}>
      <summary><strong>Receive, count or take out</strong></summary>
      <form method="post" action="/supplies" class="form-grid" style="margin-top:.8rem">
        <label class="span2">Item *<select name="product_id" required><option value="">Pick an item…</option>
          ${Object.entries(HEADINGS).map(([cat, h]) => html`<optgroup label="${h}">${products.filter((p) => p.category === cat)
            .map((p) => html`<option value="${p.product_id}" data-color="${p.stock_by_color ? 1 : ''}">${p.name}</option>`)}</optgroup>`)}
          ${products.some((p) => !HEADINGS[p.category]) ? html`<optgroup label="Other">${products.filter((p) => !HEADINGS[p.category])
            .map((p) => html`<option value="${p.product_id}" data-color="${p.stock_by_color ? 1 : ''}">${p.name}</option>`)}</optgroup>` : ''}
        </select></label>
        <label class="span2 supply-color">Color (screws)<select name="color_id"><option value="">No color</option>
          ${colors.map((c) => html`<option value="${c.color_id}">${c.label}</option>`)}</select></label>
        <label>What happened *<select name="what">
          <option value="receive">Received (add to stock)</option>
          <option value="count">Counted (this is what's on the shelf)</option>
          <option value="adjust">Used, damaged or lost (take out)</option></select></label>
        <label>How many *<input name="qty" type="number" step="0.01" min="0" required></label>
        ${prices ? html`<label>Cost each (per bag, roll or piece)<input name="unit_cost" type="number" step="0.0001" min="0"
          placeholder="what you paid"></label><span class="muted small" style="align-self:end">Received: blends into the average cost.
          Counted: sets the average cost.</span>` : ''}
        <label class="span2">Note<input name="note" placeholder="PO number, supplier, reason…"></label>
        <div class="span2 actions"><button class="btn primary">Save</button></div>
      </form>
      <script>(() => { const f = document.currentScript.closest('details').querySelector('form');
        const sync = () => { const o = f.product_id.selectedOptions[0]; f.querySelector('.supply-color').hidden = !(o && o.dataset.color); };
        f.product_id.addEventListener('change', sync); sync(); })();</script>
    </details>` : ''}
    ${shown.length ? [...groups].map(([h, list]) => html`
    <h2>${h}</h2>
    <table class="list supplies">
      <thead><tr><th>Item</th><th>Color</th><th class="num">On hand</th><th class="num">On orders</th>
        <th class="num">Available</th><th class="num">Reorder at</th><th>Where</th>${prices ? html`<th class="num">Cost each</th><th class="num">Value</th>` : ''}</tr></thead>
      <tbody>${list.map((r) => html`<tr class="${low(r) ? 'low' : ''}">
        <td>${r.supply_id ? html`<a href="/supplies/${r.supply_id}">${r.name}</a>` : r.name}</td>
        <td>${r.color || (r.stock_by_color ? html`<span class="muted">No color</span>` : '')}</td>
        <td class="num">${qty(r.on_hand, r.pricing_unit)}</td>
        <td class="num">${r.committed ? qty(r.committed, r.pricing_unit) : ''}</td>
        <td class="num"><strong>${qty(r.available, r.pricing_unit)}</strong>${low(r) ? html` <span class="low-tag">${r.available < 0 ? 'short' : 'low'}</span>` : ''}</td>
        <td class="num">${r.reorder_at === null ? '' : qty(r.reorder_at, r.pricing_unit)}</td>
        <td>${r.location}</td>${prices ? html`<td class="num">${r.avg_cost === null ? '' : money(r.avg_cost)}</td>
        <td class="num">${r.value ? money(r.value) : ''}</td>` : ''}</tr>`)}</tbody>
    </table>`) : html`<p class="muted">${lowOnly ? 'Nothing is running low.' : 'Nothing is being counted yet.'}</p>`}
    ${noColorsYet.length && !lowOnly ? html`<p class="muted small">No colors counted yet: ${noColorsYet.map((r) => r.name).join(', ')}.</p>` : ''}`,
  }));
});

router.post('/supplies', need('inventory'), async (req, res) => {
  const b = req.body;
  const { rows: [p] } = await query('SELECT product_id, stock_by_color FROM products WHERE product_id = $1 AND track_stock',
    [Number(b.product_id) || null]);
  const n = Number(b.qty);
  if (!p) return back(res, '/supplies', 'Pick an item.');
  if (!(n >= 0) || String(b.qty).trim() === '') return back(res, '/supplies', 'Enter how many.');
  if (!TXN_LABEL[b.what] || b.what === 'order') return back(res, '/supplies', 'Pick what happened.');
  const colorId = p.stock_by_color ? Number(b.color_id) || null : null;
  const cost = can('prices') && ['receive', 'count'].includes(b.what) ? optNum(b.unit_cost) : null;
  if (cost !== null && !(cost >= 0)) return back(res, '/supplies', 'Cost must be zero or more.');
  const id = await tx(async (db) => {
    const supplyId = await supplyRow(db, p.product_id, colorId);
    const { rows: [s] } = await db.query('SELECT qty_on_hand FROM supply_stock WHERE supply_id = $1 FOR UPDATE', [supplyId]);
    const delta = b.what === 'receive' ? n : b.what === 'adjust' ? -n : n - s.qty_on_hand;
    if (delta !== 0 || b.what === 'count') {
      await db.query(`INSERT INTO supply_transactions (supply_id, txn_type, qty_delta, performed_by, note, unit_cost)
        VALUES ($1, $2, $3, $4, $5, $6)`, [supplyId, b.what, delta, userName(), clean(b.note), cost]);
    }
    return supplyId;
  });
  res.redirect(`/supplies/${id}?saved=1`);
});

router.get('/supplies/:id(\\d+)', async (req, res) => {
  const { rows: [s] } = await query(`
    WITH committed AS (${COMMITTED})
    SELECT s.*, p.name, p.pricing_unit, col.label AS color, COALESCE(c.qty, 0) AS committed, cp.unit_price AS price
    FROM supply_stock s JOIN products p USING (product_id) LEFT JOIN v_colors col ON col.color_id = s.color_id
    LEFT JOIN v_current_prices cp ON cp.product_id = s.product_id
    LEFT JOIN committed c ON c.product_id = s.product_id AND c.color_id IS NOT DISTINCT FROM s.color_id
    WHERE s.supply_id = $1`, [req.params.id]);
  if (!s) return res.status(404).send('Not found');
  const { rows: history } = await query(`
    SELECT t.*, o.order_number FROM supply_transactions t LEFT JOIN orders o USING (order_id)
    WHERE t.supply_id = $1 ORDER BY t.occurred_at DESC, t.supply_txn_id DESC LIMIT 200`, [s.supply_id]);
  const { rows: open } = await query(`
    SELECT o.order_id, o.order_number, o.job_name, o.need_by, c.display_name AS customer, sum(${LINE_QTY}) AS qty
    FROM order_items oi JOIN products p USING (product_id) JOIN orders o USING (order_id) JOIN customers c ON c.customer_id = o.customer_id
    WHERE oi.product_id = $1 AND (NOT p.stock_by_color OR oi.color_id IS NOT DISTINCT FROM $2)
      AND o.status IN ('confirmed', 'in_production', 'ready')
    GROUP BY o.order_id, c.display_name ORDER BY o.need_by NULLS LAST`, [s.product_id, s.color_id]);
  const u = s.pricing_unit;
  const prices = can('prices');
  res.send(layout({
    title: s.name, active: '/supplies',
    body: html`
    <p><a href="/supplies">← Supplies</a></p>
    <h1>${s.name}${s.color ? html` <span class="muted">${s.color}</span>` : ''}</h1>
    ${alert(req)}
    <div class="rtiles">
      <div class="rtile"><div class="n">${qty(s.qty_on_hand, u) || '0'}</div><div class="label">On hand</div></div>
      <div class="rtile"><div class="n">${qty(s.committed, u) || '0'}</div><div class="label">On open orders</div></div>
      <div class="rtile"><div class="n">${qty(s.qty_on_hand - s.committed, u)}</div><div class="label">Available</div></div>
      ${prices ? html`<div class="rtile"><div class="n">${s.avg_cost === null ? '–' : money(s.avg_cost)}</div><div class="label">Average cost each</div>
        <div class="sub">${s.avg_cost === null ? 'no cost entered yet' : `${money(Math.max(s.qty_on_hand, 0) * s.avg_cost)} on hand`}</div></div>
      <div class="rtile"><div class="n">${s.price === null ? '–' : money(s.price)}</div><div class="label">Price list</div>
        <div class="sub">${s.price && s.avg_cost !== null ? `${Math.round(100 * (s.price - s.avg_cost) / s.price)}% margin` : ''}</div></div>` : ''}
    </div>
    ${can('inventory') ? html`<form method="post" action="/supplies/${s.supply_id}/settings" class="card form-grid" style="margin-top:1rem;max-width:760px">
      <label>Reorder when available drops to<input name="reorder_at" type="number" step="0.01" min="0" value="${s.reorder_at ?? ''}"></label>
      <label>Where it's kept<input name="location" value="${s.location}"></label>
      ${prices ? html`<label>Average cost each<input name="avg_cost" type="number" step="0.0001" min="0" value="${s.avg_cost ?? ''}"></label>
      <span class="muted small" style="align-self:end">Changes the cost of what's on the shelf now. Usually it's set for you when you receive stock at a cost.</span>` : ''}
      <div class="span2 actions"><button class="btn">Save</button></div>
    </form>` : ''}
    ${open.length ? html`<h2>Needed for open orders</h2>
    <table class="list"><thead><tr><th>Order</th><th>Customer</th><th>Job</th><th>Need by</th><th class="num">Qty</th></tr></thead>
      <tbody>${open.map((o) => html`<tr><td><a href="/orders/${o.order_id}">${o.order_number}</a></td><td>${o.customer}</td>
        <td>${o.job_name}</td><td>${date(o.need_by)}</td><td class="num">${qty(o.qty, u)}</td></tr>`)}</tbody></table>` : ''}
    <h2>History</h2>
    <table class="list"><thead><tr><th>When</th><th>What</th><th class="num">Change</th>${prices ? html`<th class="num">Cost each</th>` : ''}<th>By</th><th>Note</th></tr></thead>
      <tbody>${history.length ? history.map((t) => html`<tr><td>${date(t.occurred_at)}</td>
        <td>${TXN_LABEL[t.txn_type]}${t.order_id ? html` <a href="/orders/${t.order_id}">${t.order_number}</a>` : ''}</td>
        <td class="num">${t.qty_delta > 0 ? '+' : ''}${num(t.qty_delta)}</td>${prices ? html`<td class="num">${t.unit_cost === null ? '' : money(t.unit_cost)}</td>` : ''}
        <td>${t.performed_by}</td><td>${t.note}</td></tr>`)
      : html`<tr><td colspan="6" class="empty">Nothing yet.</td></tr>`}</tbody></table>`,
  }));
});

router.post('/supplies/:id(\\d+)/settings', need('inventory'), async (req, res) => {
  const r = optNum(req.body.reorder_at);
  if (r !== null && !(r >= 0)) return back(res, `/supplies/${req.params.id}`, 'Reorder point must be zero or more.');
  const cost = optNum(req.body.avg_cost);
  if (cost !== null && !(cost >= 0)) return back(res, `/supplies/${req.params.id}`, 'Cost must be zero or more.');
  await query(`UPDATE supply_stock SET reorder_at = $2, location = $3,
      avg_cost = CASE WHEN $5 THEN $4 ELSE avg_cost END WHERE supply_id = $1`,
  [req.params.id, r, clean(req.body.location), cost, can('prices') && 'avg_cost' in req.body]);
  res.redirect(`/supplies/${req.params.id}?saved=1`);
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
// Where each tool is now: out on a rental, or its own status.
const TOOLS = `
  SELECT t.*, p.name AS rental_name, cp.unit_price AS rental_price,
         r.rental_id, r.order_id, r.out_at, r.due_back, o.order_number, c.display_name AS customer,
         r.due_back < (now() AT TIME ZONE '${TZ}')::date AS overdue
  FROM tools t
  LEFT JOIN products p ON p.product_id = t.rental_product_id
  LEFT JOIN v_current_prices cp ON cp.product_id = t.rental_product_id
  LEFT JOIN tool_rentals r ON r.tool_id = t.tool_id AND r.returned_at IS NULL
  LEFT JOIN orders o ON o.order_id = r.order_id
  LEFT JOIN customers c ON c.customer_id = o.customer_id`;

const toolState = (t) => (t.rental_id
  ? html`<span class="tool-out ${t.overdue ? 'late' : ''}">Out with ${t.customer} on <a href="/orders/${t.order_id}">${t.order_number}</a>${
    t.due_back ? html`, due back ${date(t.due_back)}${t.overdue ? ' (overdue)' : ''}` : ''}</span>`
  : html`<span class="tool-${t.status}">${TOOL_STATUS[t.status]}</span>`);

async function rentalItems() {
  const { rows } = await query(`SELECT p.product_id, p.name, cp.unit_price FROM products p
    LEFT JOIN v_current_prices cp USING (product_id) WHERE p.is_rental AND p.active ORDER BY p.name`);
  return rows;
}

function toolForm(t, items) {
  const isNew = !t.tool_id;
  const opt = (v, label) => html`<option value="${v}" ${String(v) === String(t.rental_product_id ?? '') ? 'selected' : ''}>${label}</option>`;
  return html`
  <form method="post" action="${isNew ? '/tools' : `/tools/${t.tool_id}`}" class="form-grid tool-form" ${isNew ? '' : 'style="max-width:760px"'}>
    <label class="span2">Tool *<input name="name" value="${t.name}" required placeholder="Hand seamer, brake, shears…"></label>
    <label>Tag number<input name="tag" value="${t.tag}" placeholder="Written on the tool"></label>
    <label>Serial number<input name="serial_number" value="${t.serial_number}"></label>
    <label class="span2">Rented out as<select name="rental_product_id">
      <option value="">Not rented out (shop tool)</option>
      ${items.map((i) => opt(i.product_id, `${i.name}${can('prices') && i.unit_price !== null ? ` · ${money(i.unit_price)} per day` : ''}`))}
      ${can('catalog') ? html`<option value="new">New rental item…</option>` : ''}</select></label>
    ${can('catalog') ? html`<label class="new-rental" hidden>Rental item name<input name="new_rental_name" placeholder="Hand seamer rental"></label>
    <label class="new-rental" hidden>Price per day<input name="new_rental_price" type="number" step="0.01" min="0"></label>` : ''}
    <label>Where it's kept<input name="location" value="${t.location}"></label>
    ${isNew ? '' : html`<label>Status<select name="status">${Object.entries(TOOL_STATUS).map(([k, v]) =>
      html`<option value="${k}" ${t.status === k ? 'selected' : ''}>${v}</option>`)}</select></label>`}
    ${can('prices') ? html`<label>Cost<input name="purchase_cost" type="number" step="0.01" min="0" value="${t.purchase_cost ?? ''}"></label>` : ''}
    <label>Bought on<input name="purchased_on" type="date" value="${t.purchased_on}"></label>
    <label class="span2">Notes<input name="notes" value="${t.notes}"></label>
    <div class="span2 actions"><button class="btn primary">${isNew ? 'Add tool' : 'Save'}</button></div>
    <script>(() => { const f = document.currentScript.closest('form');
      const sync = () => f.querySelectorAll('.new-rental').forEach((l) => { l.hidden = f.rental_product_id.value !== 'new'; });
      f.rental_product_id.addEventListener('change', sync); sync(); })();</script>
  </form>`;
}

router.get('/tools', async (req, res) => {
  const { rows: tools } = await query(`${TOOLS} WHERE t.status <> 'retired' OR $1 ORDER BY t.name, t.tag NULLS LAST, t.tool_id`,
    [req.query.show === 'all']);
  const out = tools.filter((t) => t.rental_id);
  const toolValue = tools.filter((t) => t.status !== 'retired').reduce((a, t) => a + (t.purchase_cost || 0), 0);
  const late = out.filter((t) => t.overdue);
  res.send(layout({
    title: 'Tools', active: '/tools',
    body: html`
    <div class="page-head"><h1>Tools</h1>
      <div class="actions"><a class="btn" href="/tools${req.query.show === 'all' ? '' : '?show=all'}">${req.query.show === 'all' ? 'Hide retired' : 'Show retired'}</a></div></div>
    <p class="muted">Every tool the shop owns. To rent one out, put its rental item on a quote (the quantity is the
      number of days). Once the quote is approved, check the tool out and back in at the bottom of the order.</p>
    ${alert(req)}
    <div class="rtiles">
      <div class="rtile"><div class="n">${tools.filter((t) => t.status === 'available' && !t.rental_id).length}</div><div class="label">In the shop</div></div>
      <div class="rtile"><div class="n">${out.length}</div><div class="label">Rented out</div></div>
      <div class="rtile ${late.length ? 'warn' : ''}"><div class="n">${late.length}</div><div class="label">Overdue</div></div>
      ${can('prices') ? html`<div class="rtile"><div class="n">${money(toolValue)}</div><div class="label">Tools at cost</div></div>` : ''}
    </div>
    ${can('inventory') ? html`<details class="card" style="margin-top:1rem" ${tools.length ? '' : 'open'}>
      <summary><strong>Add a tool</strong></summary>
      <div style="margin-top:.8rem">${toolForm({}, await rentalItems())}</div>
    </details>` : ''}
    <table class="list">
      <thead><tr><th>Tool</th><th>Tag</th><th>Rented as</th><th>Where it is</th><th>Kept</th></tr></thead>
      <tbody>${tools.length ? tools.map((t) => html`<tr class="${t.status === 'retired' ? 'inactive' : ''}">
        <td><a href="/tools/${t.tool_id}">${t.name}</a></td><td>${t.tag}</td>
        <td>${t.rental_name ? html`${t.rental_name}${can('prices') && t.rental_price !== null ? html` <span class="muted small">${money(t.rental_price)}/day</span>` : ''}` : html`<span class="muted">Shop tool</span>`}</td>
        <td>${toolState(t)}</td><td>${t.location}</td></tr>`)
      : html`<tr><td colspan="5" class="empty">No tools yet.</td></tr>`}</tbody>
    </table>`,
  }));
});

function toolFromBody(b) {
  return {
    name: clean(b.name), tag: clean(b.tag), serial_number: clean(b.serial_number), location: clean(b.location),
    status: TOOL_STATUS[b.status] ? b.status : 'available', purchase_cost: optNum(b.purchase_cost),
    purchased_on: /^\d{4}-\d{2}-\d{2}$/.test(b.purchased_on || '') ? b.purchased_on : null, notes: clean(b.notes),
  };
}

// The rental item picked, or a new one made from the name and day price.
async function rentalProduct(db, b) {
  if (b.rental_product_id !== 'new') {
    const id = Number(b.rental_product_id) || null;
    if (!id) return null;
    const { rows } = await db.query('SELECT product_id FROM products WHERE product_id = $1 AND is_rental', [id]);
    if (!rows.length) throw new Error('bad rental item');
    return id;
  }
  if (!can('catalog')) throw Object.assign(new Error('Only Admins can make new rental items.'), { user: true });
  const name = clean(b.new_rental_name);
  const price = optNum(b.new_rental_price);
  if (!name) throw Object.assign(new Error('Name the new rental item, like "Hand seamer rental".'), { user: true });
  if (!(price >= 0)) throw Object.assign(new Error('Enter the price per day for the new rental item.'), { user: true });
  const full = /per day/i.test(name) ? name : `${name} (per day)`;
  const sku = `RENT-${full.toUpperCase().replace(/\(PER DAY\)/, '').replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 40);
  const { rows: [p] } = await db.query(`
    INSERT INTO products (sku, name, category, pricing_unit, taxable, is_rental)
    VALUES ($1, $2, 'service', 'each', true, true) RETURNING product_id`, [sku, full]);
  await db.query(`INSERT INTO product_prices (product_id, unit_price, effective_from, source)
    VALUES ($1, $2, current_date, 'Tools page')`, [p.product_id, price]);
  return p.product_id;
}

const toolError = (err) => (err.user ? err.message
  : err.code === '23505' ? (/sku/.test(err.constraint || '') ? 'A rental item with that name already exists. Pick it from the list.'
    : 'Another tool already has that tag number.')
  : err.message === 'bad rental item' ? 'Pick a rental item from the list.' : null);

router.post('/tools', need('inventory'), async (req, res) => {
  const t = toolFromBody(req.body);
  if (!t.name) return back(res, '/tools', 'Enter the tool name.');
  try {
    const id = await tx(async (db) => {
      const rp = await rentalProduct(db, req.body);
      const { rows: [r] } = await db.query(`
        INSERT INTO tools (name, tag, serial_number, rental_product_id, location, purchase_cost, purchased_on, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING tool_id`,
      [t.name, t.tag, t.serial_number, rp, t.location, can('prices') ? t.purchase_cost : null, t.purchased_on, t.notes]);
      return r.tool_id;
    });
    res.redirect(`/tools/${id}?saved=1`);
  } catch (err) {
    const msg = toolError(err);
    if (!msg) throw err;
    back(res, '/tools', msg);
  }
});

router.get('/tools/:id(\\d+)', async (req, res) => {
  const { rows: [t] } = await query(`${TOOLS} WHERE t.tool_id = $1`, [req.params.id]);
  if (!t) return res.status(404).send('Tool not found');
  const { rows: history } = await query(`
    SELECT r.*, o.order_number, c.display_name AS customer,
           (COALESCE(r.returned_at, now()) AT TIME ZONE '${TZ}')::date - (r.out_at AT TIME ZONE '${TZ}')::date AS days
    FROM tool_rentals r JOIN orders o USING (order_id) JOIN customers c USING (customer_id)
    WHERE r.tool_id = $1 ORDER BY r.out_at DESC`, [t.tool_id]);
  // Rent billed on the orders this tool went out on (cancelled orders left out).
  const { rows: [earned] } = await query(`
    SELECT COALESCE(sum(oi.line_total), 0) AS amount FROM order_items oi JOIN orders o USING (order_id)
    WHERE o.status <> 'cancelled' AND oi.order_item_id IN (SELECT order_item_id FROM tool_rentals WHERE tool_id = $1)`, [t.tool_id]);
  res.send(layout({
    title: t.name, active: '/tools',
    body: html`
    <p><a href="/tools">← Tools</a></p>
    <h1>${t.name}${t.tag ? html` <span class="muted">#${t.tag}</span>` : ''}</h1>
    ${alert(req)}
    <p>${toolState(t)}</p>
    ${can('prices') && (t.purchase_cost || earned.amount) ? html`<div class="rtiles" style="margin-bottom:1rem">
      <div class="rtile"><div class="n">${money(earned.amount)}</div><div class="label">Rent billed</div>
        <div class="sub">${history.length} rental${history.length === 1 ? '' : 's'}</div></div>
      ${t.purchase_cost ? html`<div class="rtile"><div class="n">${money(t.purchase_cost)}</div><div class="label">Cost</div>
        <div class="sub">${earned.amount >= t.purchase_cost ? 'paid for itself' : `${money(t.purchase_cost - earned.amount)} to pay for itself`}</div></div>` : ''}
    </div>` : ''}
    ${can('inventory') ? html`<div class="card">${toolForm(t, await rentalItems())}</div>` : ''}
    <h2>Rentals</h2>
    <table class="list"><thead><tr><th>Order</th><th>Customer</th><th>Out</th><th>Due back</th><th>Returned</th><th class="num">Days</th><th>Note</th></tr></thead>
      <tbody>${history.length ? history.map((r) => html`<tr>
        <td><a href="/orders/${r.order_id}">${r.order_number}</a></td><td>${r.customer}</td>
        <td>${date(r.out_at)}${r.out_by ? html` <span class="muted small">${r.out_by}</span>` : ''}</td><td>${date(r.due_back)}</td>
        <td>${r.returned_at ? html`${date(r.returned_at)}${r.returned_by ? html` <span class="muted small">${r.returned_by}</span>` : ''}` : html`<strong>Still out</strong>`}</td>
        <td class="num">${Math.max(1, r.days)}</td><td>${r.return_note}</td></tr>`)
      : html`<tr><td colspan="7" class="empty">Never rented out.</td></tr>`}</tbody></table>`,
  }));
});

router.post('/tools/:id(\\d+)', need('inventory'), async (req, res) => {
  const t = toolFromBody(req.body);
  const path = `/tools/${req.params.id}`;
  if (!t.name) return back(res, path, 'Enter the tool name.');
  try {
    await tx(async (db) => {
      const rp = await rentalProduct(db, req.body);
      await db.query(`
        UPDATE tools SET name = $2, tag = $3, serial_number = $4, rental_product_id = $5, location = $6,
               status = $7, purchased_on = $8, notes = $9,
               purchase_cost = CASE WHEN $11 THEN $10 ELSE purchase_cost END
        WHERE tool_id = $1`,
      [req.params.id, t.name, t.tag, t.serial_number, rp, t.location, t.status, t.purchased_on, t.notes,
        t.purchase_cost, can('prices')]);
    });
    res.redirect(`${path}?saved=1`);
  } catch (err) {
    const msg = toolError(err);
    if (!msg) throw err;
    back(res, path, msg);
  }
});

module.exports = router;
