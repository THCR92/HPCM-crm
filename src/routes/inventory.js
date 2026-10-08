// Coil inventory (one row per coil tag, tracked by linear feet) and finished stock
// (panels and trim already cut, by product, color and length).
const { query, tx } = require('../db');
const { html, layout, money, num, date } = require('../html');
const { feetInches } = require('../length');
const { footage, undoRun, runError } = require('../production');
const { can, need, userName } = require('../auth');

const router = require('../async-router')();

const COIL_STATUS = {
  in_stock: 'In stock', on_machine: 'On machine', received: 'Received',
  depleted: 'Used up', scrapped: 'Scrapped', returned: 'Returned',
};
const TXN_LABEL = {
  receive: 'Received', production: 'Run', scrap: 'Scrap', reweigh_adjust: 'Footage corrected',
  return_to_vendor: 'Returned to supplier',
};
const ON_HAND = "status IN ('received','in_stock','on_machine')";

const back = (res, path, error) =>
  res.redirect(`${path}${error ? `${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(error)}` : ''}`);
const alert = (req) => (req.query.error ? html`<div class="alert">${req.query.error}</div>` : '');
const lf = (n) => (n === null || n === undefined ? '' : `${num(n, 1)} LF`);

async function colorOptions(selected) {
  const { rows } = await query(`
    SELECT color_id, name, finish, finish_label, supplier_name FROM v_colors
    WHERE active OR color_id = $1 ORDER BY supplier_name NULLS FIRST, name, finish_sort`, [selected || null]);
  const groups = new Map();
  for (const c of rows) {
    const k = c.supplier_name || 'No supplier';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  return html`<option value="">Pick a color…</option>${[...groups].map(([sup, list]) => html`
    <optgroup label="${sup}">${list.map((c) => html`<option value="${c.color_id}" ${c.color_id === Number(selected) ? 'selected' : ''}>${c.name}${c.finish !== 'smooth' ? ` (${c.finish_label})` : ''}</option>`)}</optgroup>`)}`;
}

// ---------------------------------------------------------------------------
// Coils
// ---------------------------------------------------------------------------
router.get('/coils', async (req, res) => {
  const all = req.query.show === 'all';
  const { rows: coils } = await query(`
    SELECT * FROM v_coils ${all ? '' : `WHERE ${ON_HAND}`}
    ORDER BY ${all ? 'received_on DESC, coil_id DESC' : 'color_label, gauge, width_in, received_on'}`);
  const { rows: summary } = await query(`
    SELECT color_label, gauge, width_in, count(*) AS coils, sum(current_lf) AS lf
    FROM v_coils WHERE ${ON_HAND}
    GROUP BY color_label, gauge, width_in ORDER BY color_label, gauge, width_in`);
  const { rows: gauges } = await query('SELECT gauge_id, gauge FROM gauges ORDER BY gauge');
  res.send(layout({
    title: 'Coils', active: '/coils',
    body: html`
    <div class="page-head"><h1>Coils</h1></div>
    ${alert(req)}
    ${can('inventory') ? html`<details class="card" ${coils.length ? '' : 'open'}>
      <summary><strong>Receive a coil</strong></summary>
      <form method="post" action="/coils" class="form-grid" style="margin-top:.8rem">
        <label>Coil tag *<input name="coil_tag" required></label>
        <label class="span2">Color * (the color sets the supplier)<select name="color_id" required>${await colorOptions()}</select></label>
        <label>Gauge *<select name="gauge_id" required>${gauges.map((g) =>
          html`<option value="${g.gauge_id}" ${g.gauge === 26 ? 'selected' : ''}>${g.gauge} ga</option>`)}</select></label>
        <label>Width (in) *<input name="width_in" type="number" step="0.001" min="1" required></label>
        <label>Linear feet *<input name="initial_lf" type="number" step="0.1" min="1" required></label>
        ${can('prices') ? html`<label>Cost per LF<input name="cost_per_lf" type="number" step="0.0001" min="0"></label>` : ''}
        <label>Weight on tag (lb, optional)<input name="initial_weight_lb" type="number" step="0.1" min="0"></label>
        <label>Received on<input name="received_on" type="date"></label>
        <label>Supplier PO #<input name="supplier_po"></label>
        <label>Heat / lot #<input name="heat_number"></label>
        <label class="span2">Notes<input name="notes"></label>
        <div class="span2 actions"><button class="btn primary">Add coil</button></div>
      </form>
    </details>` : ''}

    ${summary.length ? html`
    <h2>On hand by color</h2>
    <table class="list">
      <thead><tr><th>Color</th><th>Gauge</th><th class="num">Width</th><th class="num">Coils</th>
        <th class="num">Linear feet</th></tr></thead>
      <tbody>${summary.map((s) => html`<tr><td>${s.color_label}</td><td>${s.gauge}</td>
        <td class="num">${num(s.width_in, 3)}"</td><td class="num">${s.coils}</td>
        <td class="num">${lf(s.lf)}</td></tr>`)}</tbody>
    </table>` : ''}

    <div class="page-head" style="margin-top:1.6rem">
      <h2 style="margin:0">${all ? 'All coils' : 'Coils on hand'}</h2>
      <a href="${all ? '/coils' : '/coils?show=all'}">${all ? 'Show only coils on hand' : 'Show used-up and returned coils too'}</a>
    </div>
    <table class="list">
      <thead><tr><th>Tag</th><th>Color</th><th>Gauge</th><th class="num">Width</th>
        <th class="num">Feet left</th><th>Received</th><th>Status</th></tr></thead>
      <tbody>${coils.length ? coils.map((c) => html`
        <tr><td><a href="/coils/${c.coil_id}">${c.coil_tag}</a></td><td>${c.color_label}</td><td>${c.gauge}</td>
        <td class="num">${num(c.width_in, 3)}"</td>
        <td class="num">${lf(c.current_lf)} <span class="muted small">of ${num(c.initial_lf, 0)}</span></td>
        <td>${date(c.received_on)}</td><td>${COIL_STATUS[c.status]}</td></tr>`)
      : html`<tr><td colspan="7" class="empty">No coils yet.</td></tr>`}</tbody>
    </table>`,
  }));
});

router.post('/coils', need('inventory'), async (req, res) => {
  const b = req.body;
  const tag = (b.coil_tag || '').trim();
  const feet = Number(b.initial_lf);
  const width = Number(b.width_in);
  if (!tag || !(feet > 0) || !(width > 0) || !Number(b.color_id)) {
    return back(res, '/coils', 'Coil tag, color, width and linear feet are required.');
  }
  const optional = (v) => (v === '' || v === undefined ? null : Number(v));
  try {
    const { rows: [c] } = await query(`
      INSERT INTO coils (coil_tag, color_id, gauge_id, width_in, initial_lf, current_lf,
                         cost_per_lf, initial_weight_lb, received_on, supplier_po, heat_number, notes)
      VALUES ($1, $2, $3, $4, $5, $5, $6, $11, COALESCE($7::date, current_date), $8, $9, $10)
      RETURNING coil_id`,
    [tag, Number(b.color_id), Number(b.gauge_id), width, feet, optional(b.cost_per_lf),
      b.received_on || null, (b.supplier_po || '').trim() || null, (b.heat_number || '').trim() || null,
      (b.notes || '').trim() || null, optional(b.initial_weight_lb)]);
    res.redirect(`/coils/${c.coil_id}`);
  } catch (err) {
    back(res, '/coils', err.code === '23505' ? `Coil tag ${tag} is already in the system.` : err.message);
  }
});

router.get('/coils/:id(\\d+)', async (req, res) => {
  const { rows: [c] } = await query('SELECT * FROM v_coils WHERE coil_id = $1', [req.params.id]);
  if (!c) return res.status(404).send('Coil not found');
  const { rows: history } = await query(`
    SELECT t.*, r.pieces, fn_format_length(r.length_in) AS length_display,
           o.order_id, o.order_number, oi.line_no, p.name AS product_name,
           fp.name AS stock_product
    FROM coil_transactions t
    LEFT JOIN production_runs r USING (production_run_id)
    LEFT JOIN order_items oi ON oi.order_item_id = r.order_item_id
    LEFT JOIN orders o ON o.order_id = oi.order_id
    LEFT JOIN products p ON p.product_id = oi.product_id
    LEFT JOIN finished_goods fg ON fg.finished_good_id = r.finished_good_id
    LEFT JOIN products fp ON fp.product_id = fg.product_id
    WHERE t.coil_id = $1 ORDER BY t.occurred_at, t.coil_txn_id`, [c.coil_id]);
  const onHand = ['received', 'in_stock', 'on_machine'].includes(c.status);
  const what = (t) => {
    if (t.order_id) {
      return html`<a href="/orders/${t.order_id}">${t.order_number}</a> line ${t.line_no}: ${t.pieces} × ${t.length_display} ${t.product_name}`;
    }
    if (t.stock_product) return html`To stock: ${t.pieces} × ${t.length_display} ${t.stock_product}`;
    return t.note || '';
  };
  res.send(layout({
    title: `Coil ${c.coil_tag}`, active: '/coils',
    body: html`
    <div class="page-head"><h1>Coil ${c.coil_tag} <span class="badge">${COIL_STATUS[c.status]}</span></h1>
      <a href="/coils">All coils</a></div>
    ${alert(req)}
    <div class="card"><dl class="details">
      <dt>Color</dt><dd>${c.color_label}</dd>
      <dt>Supplier</dt><dd>${c.supplier_name}</dd>
      <dt>Gauge / width</dt><dd>${c.gauge} ga, ${num(c.width_in, 3)}" wide</dd>
      <dt>Feet left</dt><dd><strong>${lf(c.current_lf)}</strong> of ${lf(c.initial_lf)}</dd>
      ${c.initial_weight_lb ? html`<dt>Weight on tag</dt><dd>${num(c.initial_weight_lb, 1)} lb</dd>` : ''}
      ${c.cost_per_lf && can('prices') ? html`<dt>Cost</dt><dd>${money(c.cost_per_lf)}/LF · ${money(c.current_lf * c.cost_per_lf)} left</dd>` : ''}
      <dt>Received</dt><dd>${date(c.received_on)}${c.supplier_po ? ` · PO ${c.supplier_po}` : ''}${c.heat_number ? ` · heat ${c.heat_number}` : ''}</dd>
      ${c.notes ? html`<dt>Notes</dt><dd>${c.notes}</dd>` : ''}
    </dl></div>
    ${onHand && can('inventory') ? html`
    <div class="form-row">
      <form method="post" action="/coils/${c.coil_id}/correct" class="card form-row">
        <label>Measured it? Actual feet left<input name="actual_lf" type="number" step="0.1" min="0" required></label>
        <button class="btn">Correct footage</button>
      </form>
      <form method="post" action="/coils/${c.coil_id}/close" class="card form-row"
            onsubmit="return confirm('Take this coil off the on-hand list?')">
        <label>Done with this coil?
          <select name="reason"><option value="used_up">Used up (rest is scrap)</option>
            <option value="returned">Returned to supplier</option></select></label>
        <button class="btn">Close coil</button>
      </form>
    </div>` : ''}
    <h2>History</h2>
    <table class="list">
      <thead><tr><th>Date</th><th>What</th><th>By</th><th class="num">Feet</th></tr></thead>
      <tbody>${history.map((t) => html`<tr>
        <td>${date(t.occurred_at)}</td>
        <td>${TXN_LABEL[t.txn_type]}${t.txn_type === 'production' || t.txn_type === 'scrap' ? html`: ${what(t)}` : t.note && t.txn_type !== 'receive' ? `: ${t.note}` : ''}
</td>
        <td>${t.performed_by}</td>
        <td class="num">${t.lf_delta > 0 ? '+' : ''}${num(t.lf_delta, 1)} LF</td></tr>`)}</tbody>
    </table>`,
  }));
});

router.post('/coils/:id(\\d+)/correct', need('inventory'), async (req, res) => {
  const id = Number(req.params.id);
  const actual = Number(req.body.actual_lf);
  if (!(actual >= 0)) return back(res, `/coils/${id}`, 'Enter the feet left on the coil.');
  try {
    await tx(async (db) => {
      const { rows: [c] } = await db.query('SELECT current_lf, initial_lf FROM coils WHERE coil_id = $1 FOR UPDATE', [id]);
      if (actual > c.initial_lf) throw new Error('That is more footage than the coil came with.');
      const delta = Math.round((actual - c.current_lf) * 10) / 10;
      if (delta !== 0) {
        await db.query(`INSERT INTO coil_transactions (coil_id, txn_type, lf_delta, note)
                        VALUES ($1, 'reweigh_adjust', $2, $3)`, [id, delta, `Measured ${actual} LF left`]);
      }
    });
    res.redirect(`/coils/${id}`);
  } catch (err) {
    back(res, `/coils/${id}`, err.message);
  }
});

router.post('/coils/:id(\\d+)/close', need('inventory'), async (req, res) => {
  const id = Number(req.params.id);
  const returned = req.body.reason === 'returned';
  await tx(async (db) => {
    const { rows: [c] } = await db.query('SELECT current_lf FROM coils WHERE coil_id = $1 FOR UPDATE', [id]);
    if (c.current_lf > 0) {
      await db.query(`INSERT INTO coil_transactions (coil_id, txn_type, lf_delta, note)
                      VALUES ($1, $2, $3, $4)`,
      [id, returned ? 'return_to_vendor' : 'scrap', -c.current_lf,
        returned ? 'Returned to supplier' : 'Coil closed out']);
    }
    await db.query('UPDATE coils SET status = $2 WHERE coil_id = $1',
      [id, returned ? 'returned' : 'depleted']);
  });
  res.redirect(`/coils/${id}`);
});

// ---------------------------------------------------------------------------
// Finished stock
// ---------------------------------------------------------------------------
router.get('/stock', async (req, res) => {
  const { rows: stock } = await query(`
    SELECT fg.*, p.name AS product_name, p.category, col.label AS color_label,
           fn_format_length(fg.length_in) AS length_display
    FROM finished_goods fg JOIN products p USING (product_id) JOIN v_colors col ON col.color_id = fg.color_id
    WHERE fg.qty_on_hand > 0
    ORDER BY p.name, col.label, fg.length_in DESC`);
  const { rows: products } = await query(`
    SELECT product_id, name, category FROM products
    WHERE active AND category IN ('panel', 'trim', 'custom_trim', 'flat_sheet')
    ORDER BY array_position(enum_range(NULL::product_category), category), name`);
  const { rows: coils } = await query(`SELECT coil_id, coil_tag, color_label, gauge, current_lf
                                       FROM v_coils WHERE ${ON_HAND} ORDER BY coil_tag`);
  res.send(layout({
    title: 'Stock', active: '/stock',
    body: html`
    <div class="page-head"><h1>Finished stock</h1></div>
    <p class="muted">Panels and trim already cut: run ahead to stock, or remnants left over from a job.</p>
    ${alert(req)}
    ${can('inventory') ? html`<details class="card" ${stock.length ? '' : 'open'}>
      <summary><strong>Add to stock</strong></summary>
      <form method="post" action="/stock" class="form-grid" style="margin-top:.8rem">
        <label class="span2">Product *<select name="product_id" required><option value="">Pick a product…</option>
          ${products.map((p) => html`<option value="${p.product_id}">${p.name}</option>`)}</select></label>
        <label class="span2">Color *<select name="color_id" required>${await colorOptions()}</select></label>
        <label>Pieces *<input name="qty" type="number" min="1" step="1" required></label>
        <label>Length *<span class="row"><input name="ft" inputmode="numeric" placeholder="ft" required><span class="unit">'</span>
          <input name="inch" placeholder="in"><span class="unit">"</span></span></label>
        <label class="check"><input type="checkbox" name="remnant" value="1"> Remnant / leftover</label>
        <span></span>
        <label class="span2">Cut from coil (optional, takes the footage off the coil)
          <select name="coil_id"><option value="">Not from a coil / already counted</option>
          ${coils.map((c) => html`<option value="${c.coil_id}">${c.coil_tag}: ${c.color_label}, ${c.gauge} ga (${num(c.current_lf, 0)} LF left)</option>`)}</select></label>
        <label>Coil feet used<input name="lf_used" type="number" step="0.1" min="0" placeholder="pieces × length"></label>
        <label>By<input name="operator" value="${userName()}"></label>
        <div class="span2 actions"><button class="btn primary">Add to stock</button></div>
      </form>
    </details>` : ''}
    <table class="list">
      <thead><tr><th>Product</th><th>Color</th><th>Length</th><th class="num">On hand</th><th></th><th></th></tr></thead>
      <tbody>${stock.length ? stock.map((s) => html`
        <tr><td>${s.product_name}</td><td>${s.color_label}</td><td>${s.length_display}</td>
        <td class="num">${s.qty_on_hand}</td><td>${s.is_remnant ? 'Remnant' : ''}</td>
        <td class="num">${can('inventory') ? html`<form method="post" action="/stock/${s.finished_good_id}/remove" class="inline">
          <input name="qty" type="number" min="1" max="${s.qty_on_hand}" step="1" placeholder="Pieces" required style="width:5.5rem">
          <select name="reason"><option value="sell">Sold / used on a job</option><option value="scrap">Scrapped</option>
            <option value="adjust">Count correction</option></select>
          <button class="btn small">Take out</button></form>` : ''}</td></tr>`)
      : html`<tr><td colspan="6" class="empty">Nothing in stock.</td></tr>`}</tbody>
    </table>`,
  }));
});

router.post('/stock', need('inventory'), async (req, res) => {
  const b = req.body;
  const qty = Number(b.qty);
  const len = feetInches(b.ft, b.inch);
  const productId = Number(b.product_id);
  const colorId = Number(b.color_id);
  if (!productId || !colorId || !(qty > 0) || !Number.isInteger(qty)) {
    return back(res, '/stock', 'Pick a product and color and enter a whole number of pieces.');
  }
  if (!(len > 0)) return back(res, '/stock', 'Enter the length in feet and inches, like 12 and 6 1/2.');
  try {
    await tx(async (db) => {
      const { rows: [fg] } = await db.query(`
        INSERT INTO finished_goods (product_id, color_id, length_in, is_remnant)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (product_id, color_id, length_in, location_id, is_remnant)
        DO UPDATE SET updated_at = now() RETURNING finished_good_id`,
      [productId, colorId, len, b.remnant === '1']);
      const coilId = Number(b.coil_id) || null;
      if (coilId) {
        const typed = Number(b.lf_used);
        const used = typed > 0 ? typed : footage(qty, len);
        // The run trigger takes the footage off the coil and adds the pieces to stock.
        await db.query(`
          INSERT INTO production_runs (coil_id, finished_good_id, pieces, length_in, lf_used, operator)
          VALUES ($1, $2, $3, $4, $5, $6)`,
        [coilId, fg.finished_good_id, qty, len, used, (b.operator || '').trim() || null]);
      } else {
        await db.query(`INSERT INTO finished_goods_transactions (finished_good_id, txn_type, qty_delta, performed_by, note)
                        VALUES ($1, 'adjust', $2, $3, 'Added to stock')`,
        [fg.finished_good_id, qty, (b.operator || '').trim() || null]);
      }
    });
    res.redirect('/stock');
  } catch (err) {
    back(res, '/stock', runError(err) || err.message);
  }
});

router.post('/stock/:id(\\d+)/remove', need('inventory'), async (req, res) => {
  const qty = Number(req.body.qty);
  const reason = ['sell', 'scrap', 'adjust'].includes(req.body.reason) ? req.body.reason : 'adjust';
  if (!(qty > 0) || !Number.isInteger(qty)) return back(res, '/stock', 'Enter a whole number of pieces.');
  try {
    await query(`INSERT INTO finished_goods_transactions (finished_good_id, txn_type, qty_delta, note)
                 VALUES ($1, $2, $3, 'Taken out of stock')`, [req.params.id, reason, -qty]);
    res.redirect('/stock');
  } catch (err) {
    back(res, '/stock', err.code === '23514' ? "There aren't that many pieces in stock." : err.message);
  }
});

// Undo a run logged by mistake (from the coil or order page).
router.post('/runs/:id(\\d+)/undo', need('production'), async (req, res) => {
  const backTo = typeof req.body.back === 'string' && req.body.back.startsWith('/') ? req.body.back : '/coils';
  try {
    await tx((db) => undoRun(db, Number(req.params.id)));
    res.redirect(backTo);
  } catch (err) {
    const msg = runError(err);
    if (!msg) throw err;
    back(res, backTo, msg);
  }
});

module.exports = router;
