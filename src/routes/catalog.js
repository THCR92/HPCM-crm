// Price list and colors.
const { query } = require('../db');
const { html, layout, money, num, date, UNIT_LABEL } = require('../html');
const { can, need } = require('../auth');
const CustomerTypes = require('../customer-types');

const router = require('../async-router')();

const CATEGORY_LABEL = {
  panel: 'Panels', custom_trim: 'Custom trim', trim: 'Trims & specialty cuts', flat_sheet: 'Flat sheet',
  downspout: 'Downspouts & elbows',
  boot: 'Boots', jack: 'Jacks', fastener: 'Screws', accessory: 'Accessories',
  service: 'Services', delivery: 'Delivery',
};

router.get('/products', need('prices'), async (req, res) => {
  const { rows } = await query(`
    SELECT p.product_id, p.sku, p.name, p.category, p.pricing_unit, p.price_varies,
           p.standard_length_in, p.girth_in, p.flat_extra_in,
           cp.unit_price, cp.effective_from
    FROM products p LEFT JOIN v_current_prices cp USING (product_id)
    WHERE p.active ORDER BY array_position(enum_range(NULL::product_category), p.category), p.name`);
  const { rows: [tax] } = await query("SELECT value FROM app_settings WHERE key = 'sales_tax_rate'");
  const premiums = await CustomerTypes.premiums();
  const groups = {};
  for (const r of rows) (groups[r.category] ||= []).push(r);
  const edit = can('catalog');
  res.send(layout({
    title: 'Price list', active: '/products',
    body: html`
    <div class="page-head"><h1>Price list</h1>
      ${edit ? html`<form method="post" action="/settings/tax" class="inline">
        <label class="inline-date">Sales tax for new quotes
          <input name="sales_tax_rate" type="number" step="0.001" min="0" max="99" value="${tax ? Number(tax.value) : ''}"
            style="width:6rem">%</label>
        <button class="btn small">Save</button>
      </form>` : html`<span>Sales tax for new quotes: ${tax ? Number(tax.value) : ''}%</span>`}
      ${can('screws') ? html`<a class="btn" href="/admin/screws">Screws and clips</a>` : ''}
      ${edit ? html`<a class="btn primary" href="/admin/products/new?back=products">+ Add product</a>` : ''}</div>
    ${req.query.saved === 'premiums' ? html`<div class="notice">Customer premiums saved. New quote lines use them.</div>` : ''}
    <details class="card" ${req.query.saved === 'premiums' ? 'open' : ''}>
      <summary><strong>Customer type premiums</strong> <span class="muted small">${CustomerTypes.TYPES.filter((t) => premiums[t])
    .map((t) => `${CustomerTypes.TYPE_LABEL[t]} ${premiums[t] > 0 ? '+' : ''}${premiums[t]}%`).join(' · ') || 'none set: everyone pays list price'}</span></summary>
      <p class="muted small">A percent added to price list prices (with any color premium) on new quote lines, by the customer's type.
        Use a minus number for a discount, e.g. -10 for supply houses. Quotes already written keep their prices.</p>
      ${can('catalog') ? html`<form method="post" action="/settings/premiums" class="form-row">
        ${CustomerTypes.TYPES.map((t) => html`<label>${CustomerTypes.TYPE_LABEL[t]} %
          <input name="${t}" type="number" step="0.01" min="-99" max="500" value="${premiums[t] || ''}" placeholder="0" style="width:6rem"></label>`)}
        <button class="btn">Save premiums</button></form>`
    : html`<p>${CustomerTypes.TYPES.map((t) => `${CustomerTypes.TYPE_LABEL[t]}: ${premiums[t]}%`).join(' · ')}</p>`}
    </details>
    <p class="muted">Prices are for standard stock colors. Change a price here and new order lines use it
    from today on; orders already written keep the price they were written at.</p>
    <p class="muted">Trim and downspouts are priced per 10' piece; other lengths are billed in proportion
    (a 20' piece counts as two). <strong>Flat width</strong> is how wide a strip of coil one piece takes;
    it decides how many pieces come out across a coil when production is logged. Quotes take a flat width on every
    trim line; for a trim with a flat width set here, a line at another width is priced by it (list price per inch).</p>
    ${req.query.saved ? html`<div class="notice">Saved.</div>` : ''}
    ${Object.entries(groups).map(([cat, items]) => {
    const cut = ['trim', 'downspout'].includes(cat);
    return html`
      <h2>${CATEGORY_LABEL[cat] || cat}</h2>
      <table class="list">
        <thead><tr><th>Product</th><th>Unit</th>${cut ? html`<th>Flat width</th>` : ''}<th class="num">Price</th><th>Since</th><th></th></tr></thead>
        <tbody>${items.map((p) => html`
          <tr><td>${p.name}<div class="muted small">${p.sku}${edit ? html` · <a href="/admin/products/${p.product_id}?back=products">edit</a>
            · <a href="/admin/products/new?from=${p.product_id}&back=products" title="Start a new product with this one's settings">copy</a>` : ''}${can('screws') && p.category !== 'panel' ? html` · <a href="/admin/screws?for=i:${p.product_id}">screws</a>` : ''}</div></td>
          <td>${p.pricing_unit === 'each' && p.standard_length_in ? `per ${num(p.standard_length_in / 12)}' piece` : UNIT_LABEL[p.pricing_unit]}</td>
          ${cut ? html`<td>${edit ? html`<form method="post" action="/products/${p.product_id}/girth" class="inline">
            <input name="girth_in" type="number" step="0.125" min="0" value="${p.girth_in ?? ''}" placeholder="inches" style="width:5.5rem">
            <button class="btn small">Save</button></form>` : (p.girth_in ? `${num(p.girth_in, 3)}"` : '')}${p.flat_extra_in && p.girth_in ? html`
            <div class="muted small">${num(p.girth_in - p.flat_extra_in, 3)}" finished; flat is ${num(p.flat_extra_in, 3)}" wider</div>` : ''}</td>` : ''}
          <td class="num">${p.unit_price !== null ? money(p.unit_price) : html`<span class="muted">${p.price_varies ? 'Varies' : '—'}</span>`}</td>
          <td>${date(p.effective_from)}</td>
          <td>${edit ? html`<form method="post" action="/products/${p.product_id}/price" class="inline">
            <input name="unit_price" type="number" step="0.01" min="0" placeholder="New price" required>
            <button class="btn small">Set</button></form>` : ''}</td></tr>`)}
        </tbody>
      </table>`;
  })}`,
  }));
});

router.post('/products/:id(\\d+)/price', need('catalog'), async (req, res) => {
  const price = Number(req.body.unit_price);
  if (!(price >= 0)) return res.status(400).send('Enter a valid price');
  await query(`
    INSERT INTO product_prices (product_id, unit_price, effective_from, source)
    VALUES ($1, $2, current_date, 'Edited in CRM')
    ON CONFLICT (product_id, effective_from) DO UPDATE SET unit_price = EXCLUDED.unit_price`,
  [req.params.id, price]);
  res.redirect('/products?saved=1');
});

const loadFinishes = async () => (await query('SELECT * FROM color_finishes ORDER BY sort_order, label')).rows;
const loadGauges = async () => (await query('SELECT gauge_id, gauge FROM gauges ORDER BY gauge')).rows;
// Suppliers for the pickers: the ones shown on the lists, plus the color's own supplier.
const loadSuppliers = async (keep) => (await query(
  'SELECT * FROM suppliers WHERE active OR supplier_id = $1 ORDER BY name', [keep || null])).rows;
const GAUGES_SQL = `(SELECT array_agg(g.gauge ORDER BY g.gauge) FROM color_gauges cg JOIN gauges g USING (gauge_id)
                     WHERE cg.color_id = v_colors.color_id) AS gauges`;
const gaugeText = (list) => (list && list.length ? `${list.join(', ')} ga` : 'Any');

// The gauges a color is stocked in. None ticked = it goes with any gauge.
async function saveGauges(colorId, gaugeIds) {
  await query('DELETE FROM color_gauges WHERE color_id = $1', [colorId]);
  if (gaugeIds.length) {
    await query(`INSERT INTO color_gauges (color_id, gauge_id)
                 SELECT $1, gauge_id FROM gauges WHERE gauge_id = ANY ($2::smallint[])`, [colorId, gaugeIds]);
  }
}

function colorFields(c, suppliers, finishes, gauges, picked = []) {
  const opt = (val, cur, label) => html`<option value="${val}" ${String(val) === String(cur) ? 'selected' : ''}>${label}</option>`;
  return html`
      <label>Supplier *
        <select name="supplier_id" required>
          <option value="">Pick a supplier…</option>
          ${suppliers.map((s) => opt(s.supplier_id, c.supplier_id, s.name))}
        </select></label>
      <label>Color name *<input name="name" required value="${c.name || ''}"></label>
      <label>Supplier's color code<input name="manufacturer_code" value="${c.manufacturer_code || ''}"></label>
      <label>Finish
        <select name="finish">${finishes.map((f) => opt(f.finish, c.finish || 'smooth', f.label))}</select></label>
      <label>Price premium %<input name="upcharge_pct" type="number" step="0.01" min="0" value="${c.upcharge_pct ?? 0}"></label>
      <label class="check"><input type="checkbox" name="special" value="1" ${c.is_stock_color === false ? 'checked' : ''}> Special order (not stocked)</label>
      <fieldset class="gauge-picks"><legend>Stocked in (leave all empty for any gauge)</legend>
        ${gauges.map((g) => html`<label class="check"><input type="checkbox" name="gauge" value="${g.gauge_id}"
          ${picked.map(Number).includes(Number(g.gauge)) ? 'checked' : ''}> ${g.gauge} ga</label>`)}
      </fieldset>`;
}

function colorFromBody(b) {
  return {
    supplier_id: Number(b.supplier_id) || null,
    name: (b.name || '').trim(),
    manufacturer_code: (b.manufacturer_code || '').trim() || null,
    finish: typeof b.finish === 'string' && b.finish ? b.finish : 'smooth',
    upcharge_pct: Math.max(0, Number(b.upcharge_pct) || 0),
    is_stock_color: b.special !== '1',
    gauge_ids: [].concat(b.gauge || []).map(Number).filter((n) => n > 0),
  };
}

const colorError = (err, c) => {
  if (err.code === '23505') return `${c.name} in that finish is already on the list for that supplier.`;
  if (err.code === '23503') return 'Pick a supplier and finish from the lists.';
  return err.message;
};

router.post('/products/:id(\\d+)/girth', need('catalog'), async (req, res) => {
  const g = req.body.girth_in === '' ? null : Number(req.body.girth_in);
  if (g !== null && !(g > 0)) return res.status(400).send('Enter the flat width in inches');
  await query('UPDATE products SET girth_in = $2 WHERE product_id = $1', [req.params.id, g]);
  res.redirect('/products?saved=1');
});

// Premium per customer type (Tyler 2026-11-11).
router.post('/settings/premiums', need('catalog'), async (req, res) => {
  for (const t of CustomerTypes.TYPES) {
    const v = req.body[t] === undefined || req.body[t] === '' ? 0 : Number(req.body[t]);
    if (!(v > -100 && v <= 500)) return res.status(400).send(`${CustomerTypes.TYPE_LABEL[t]}: enter a percent from -99 to 500`);
    await query(`INSERT INTO customer_type_premiums (customer_type, premium_pct) VALUES ($1, $2)
      ON CONFLICT (customer_type) DO UPDATE SET premium_pct = EXCLUDED.premium_pct, updated_at = now()`, [t, v]);
  }
  res.redirect('/products?saved=premiums');
});

// Default sales tax percent copied onto new orders (each order can still change it).
router.post('/settings/tax', need('catalog'), async (req, res) => {
  const r = Number(req.body.sales_tax_rate);
  if (req.body.sales_tax_rate === '' || !(r >= 0 && r < 100)) return res.status(400).send('Enter a percent from 0 to 99');
  await query(`INSERT INTO app_settings (key, value) VALUES ('sales_tax_rate', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [String(r)]);
  res.redirect('/products?saved=1');
});

router.get('/colors', async (req, res) => {
  const { rows: colors } = await query(`
    SELECT v_colors.*, s.active AS supplier_active, ${GAUGES_SQL}
    FROM v_colors LEFT JOIN suppliers s USING (supplier_id)
    ORDER BY s.active DESC NULLS FIRST, supplier_name NULLS FIRST, finish_sort, v_colors.name`);
  const suppliers = await loadSuppliers();
  const finishes = await loadFinishes();
  const gauges = await loadGauges();
  const groups = new Map();
  for (const c of colors) {
    const key = c.supplier_name || 'No supplier yet';
    if (!groups.has(key)) groups.set(key, { off: c.supplier_active === false, list: [] });
    groups.get(key).list.push(c);
  }
  const table = (list) => html`
      <table class="list">
        <thead><tr><th>Color</th><th>Code</th><th>Finish</th><th>Stocked in</th><th>Stock or special</th><th class="num">Premium</th><th></th></tr></thead>
        <tbody>${list.map((c) => html`
          <tr class="${c.active ? '' : 'inactive'}"><td>${c.name}${c.active ? '' : html` <span class="muted small">(hidden)</span>`}${
            c.paint_system ? html`<div class="muted small">${c.paint_system}</div>` : ''}</td>
          <td>${c.manufacturer_code}</td><td>${c.finish_label}</td><td>${gaugeText(c.gauges)}</td>
          <td>${c.is_stock_color ? 'Stock' : 'Special order'}</td>
          <td class="num">${Number(c.upcharge_pct) ? `${Number(c.upcharge_pct)}%` : ''}</td>
          <td class="num">${edit ? html`<a href="/colors/${c.color_id}/edit">Edit</a>` : ''}</td></tr>`)}
        </tbody>
      </table>`;
  const edit = can('catalog');
  res.send(layout({
    title: 'Colors', active: '/colors',
    body: html`
    <div class="page-head"><h1>Colors</h1></div>
    <p class="muted">Each color belongs to the supplier it comes from, because the same color name
    from two suppliers doesn't match. The price premium is added to the price of any panel or trim
    ordered in that color (use it for textured, metallic, PVDF and special-order colors). The same color name can be listed
    more than once for a supplier if it comes in more than one finish. "Stocked in" is the gauges a color comes in:
    a quote line only offers the colors stocked in its gauge (trim with no gauge counts as 26 ga).</p>
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    ${req.query.note ? html`<div class="notice">${req.query.note}</div>` : ''}
    ${edit ? html`<h2>Add a supplier</h2>
    <form method="post" action="/suppliers" class="card form-row">
      <label>Supplier name<input name="name" required></label>
      <label>Phone<input name="phone" type="tel"></label>
      <label>Email<input name="email" type="email"></label>
      <button class="btn">Add supplier</button>
    </form>
    <h2>Add a color</h2>
    ${suppliers.length ? html`
    <form method="post" action="/colors" class="card form-row">
      ${colorFields({}, suppliers, finishes, gauges)}
      <button class="btn primary">Add color</button>
    </form>` : html`<p class="card muted">Add a supplier first, then its colors.</p>`}
    <details class="card">
      <summary>Finishes: ${finishes.map((f) => f.label).join(', ')}</summary>
      <form method="post" action="/finishes" class="form-row" style="margin-top:.8rem">
        <label>New finish name<input name="label" required></label>
        <button class="btn">Add finish</button>
      </form>
    </details>` : ''}
    ${[...groups].map(([supplier, { off, list }]) => {
      const shown = list.filter((c) => c.active);
      const hidden = list.filter((c) => !c.active);
      if (off) {
        return html`<details class="card"><summary>${supplier} (taken off the lists, ${list.length} colors)</summary>${table(list)}</details>`;
      }
      return html`
      <h2>${supplier} <span class="muted small">${shown.length} colors</span></h2>
      ${shown.length ? table(shown) : ''}
      ${hidden.length ? html`<details><summary class="muted">${hidden.length} hidden colors</summary>${table(hidden)}</details>` : ''}`;
    })}
    ${colors.length ? '' : html`<p class="muted">No colors yet.</p>`}`,
  }));
});

router.post('/suppliers', need('catalog'), async (req, res) => {
  const name = (req.body.name || '').trim();
  try {
    await query('INSERT INTO suppliers (name, phone, email) VALUES ($1, $2, $3)',
      [name, (req.body.phone || '').trim() || null, (req.body.email || '').trim() || null]);
    res.redirect('/colors');
  } catch (err) {
    const msg = err.code === '23505' ? `${name} is already a supplier.` : err.message;
    res.redirect(`/colors?error=${encodeURIComponent(msg)}`);
  }
});

router.post('/finishes', need('catalog'), async (req, res) => {
  const label = (req.body.label || '').trim();
  const finish = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!finish) return res.redirect('/colors');
  try {
    await query('INSERT INTO color_finishes (finish, label) VALUES ($1, $2)', [finish, label]);
    res.redirect('/colors');
  } catch (err) {
    const msg = err.code === '23505' ? `${label} is already a finish.` : err.message;
    res.redirect(`/colors?error=${encodeURIComponent(msg)}`);
  }
});

router.post('/colors', need('catalog'), async (req, res) => {
  const c = colorFromBody(req.body);
  try {
    const { rows: [added] } = await query(`INSERT INTO colors (supplier_id, name, manufacturer_code, finish, upcharge_pct, is_stock_color)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING color_id`,
    [c.supplier_id, c.name, c.manufacturer_code, c.finish, c.upcharge_pct, c.is_stock_color]);
    await saveGauges(added.color_id, c.gauge_ids);
    res.redirect('/colors');
  } catch (err) {
    res.redirect(`/colors?error=${encodeURIComponent(colorError(err, c))}`);
  }
});

router.get('/colors/:id(\\d+)/edit', need('catalog'), async (req, res) => {
  const { rows: [c] } = await query(`SELECT v_colors.*, ${GAUGES_SQL} FROM v_colors WHERE color_id = $1`, [req.params.id]);
  if (!c) return res.status(404).send('Color not found');
  const suppliers = await loadSuppliers(c.supplier_id);
  const finishes = await loadFinishes();
  const gauges = await loadGauges();
  res.send(layout({
    title: `Edit ${c.name}`, active: '/colors',
    body: html`
    <h1>Edit color</h1>
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    <p class="muted">Changing the premium only affects new order lines. Orders already written keep their prices.</p>
    <form method="post" action="/colors/${c.color_id}" class="card form-row">
      ${colorFields(c, suppliers, finishes, gauges, c.gauges || [])}
      <label class="check"><input type="checkbox" name="active" value="1" ${c.active ? 'checked' : ''}> Show on new orders</label>
      <button class="btn primary">Save color</button>
      <a class="btn" href="/colors">Cancel</a>
    </form>
    <form method="post" action="/colors/${c.color_id}/delete" class="card"
      onsubmit="return confirm('Remove ${c.name.replace(/['"\\<>]/g, '')} from the color list?')">
      <p class="muted small">Removing takes the color off the list. If it's on any quote, order or coil, it's hidden
        instead so those keep their color.</p>
      <button class="btn danger">Remove color</button>
    </form>`,
  }));
});

router.post('/colors/:id(\\d+)', need('catalog'), async (req, res) => {
  const c = colorFromBody(req.body);
  try {
    await query(`UPDATE colors SET supplier_id = $1, name = $2, manufacturer_code = $3, finish = $4,
                        upcharge_pct = $5, is_stock_color = $6, active = $7
                 WHERE color_id = $8`,
    [c.supplier_id, c.name, c.manufacturer_code, c.finish, c.upcharge_pct, c.is_stock_color,
      req.body.active === '1', req.params.id]);
    await saveGauges(req.params.id, c.gauge_ids);
    res.redirect('/colors');
  } catch (err) {
    res.redirect(`/colors/${req.params.id}/edit?error=${encodeURIComponent(colorError(err, c))}`);
  }
});

// Remove a color (Tyler 2026-11-11). One already used on a quote, order, coil or stock is
// hidden instead, so those records keep it.
router.post('/colors/:id(\\d+)/delete', need('catalog'), async (req, res) => {
  const { rows: [c] } = await query(`SELECT name,
      (SELECT count(*) FROM order_items WHERE color_id = $1) + (SELECT count(*) FROM coils WHERE color_id = $1)
      + (SELECT count(*) FROM finished_goods WHERE color_id = $1) + (SELECT count(*) FROM supply_stock WHERE color_id = $1) AS uses
    FROM colors WHERE color_id = $1`, [req.params.id]);
  if (!c) return res.status(404).send('Color not found');
  let note;
  if (Number(c.uses)) {
    await query('UPDATE colors SET active = false WHERE color_id = $1', [req.params.id]);
    note = `${c.name} is on quotes, orders or coils already, so it's hidden instead of removed. It won't show on new quotes.`;
  } else {
    await query('DELETE FROM colors WHERE color_id = $1', [req.params.id]);
    note = `${c.name} was removed.`;
  }
  res.redirect(`/colors?note=${encodeURIComponent(note)}`);
});

module.exports = router;
