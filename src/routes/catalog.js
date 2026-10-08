// Price list and colors.
const { query } = require('../db');
const { html, layout, money, num, date, UNIT_LABEL } = require('../html');
const { can, need } = require('../auth');

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
      </form>` : html`<span>Sales tax for new quotes: ${tax ? Number(tax.value) : ''}%</span>`}</div>
    <p class="muted">Prices are for standard stock colors. Change a price here and new order lines use it
    from today on; orders already written keep the price they were written at.</p>
    <p class="muted">Trim and downspouts are priced per 10' piece; other lengths are billed in proportion
    (a 20' piece counts as two). <strong>Flat width</strong> is how wide a strip of coil one piece takes;
    it decides how many pieces come out across a coil when production is logged.</p>
    ${req.query.saved ? html`<div class="notice">Saved.</div>` : ''}
    ${Object.entries(groups).map(([cat, items]) => {
    const cut = ['trim', 'downspout'].includes(cat);
    return html`
      <h2>${CATEGORY_LABEL[cat] || cat}</h2>
      <table class="list">
        <thead><tr><th>Product</th><th>Unit</th>${cut ? html`<th>Flat width</th>` : ''}<th class="num">Price</th><th>Since</th><th></th></tr></thead>
        <tbody>${items.map((p) => html`
          <tr><td>${p.name}<div class="muted small">${p.sku}</div></td>
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

function colorFields(c, suppliers, finishes) {
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
      <label class="check"><input type="checkbox" name="special" value="1" ${c.is_stock_color === false ? 'checked' : ''}> Special order (not stocked)</label>`;
}

function colorFromBody(b) {
  return {
    supplier_id: Number(b.supplier_id) || null,
    name: (b.name || '').trim(),
    manufacturer_code: (b.manufacturer_code || '').trim() || null,
    finish: typeof b.finish === 'string' && b.finish ? b.finish : 'smooth',
    upcharge_pct: Math.max(0, Number(b.upcharge_pct) || 0),
    is_stock_color: b.special !== '1',
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

// Default sales tax percent copied onto new orders (each order can still change it).
router.post('/settings/tax', need('catalog'), async (req, res) => {
  const r = Number(req.body.sales_tax_rate);
  if (req.body.sales_tax_rate === '' || !(r >= 0 && r < 100)) return res.status(400).send('Enter a percent from 0 to 99');
  await query(`INSERT INTO app_settings (key, value) VALUES ('sales_tax_rate', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [String(r)]);
  res.redirect('/products?saved=1');
});

router.get('/colors', async (req, res) => {
  const { rows: colors } = await query(
    'SELECT * FROM v_colors ORDER BY supplier_name NULLS FIRST, active DESC, name, finish_sort');
  const { rows: suppliers } = await query('SELECT * FROM suppliers ORDER BY name');
  const finishes = await loadFinishes();
  const groups = new Map();
  for (const c of colors) {
    const key = c.supplier_name || 'No supplier yet';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const edit = can('catalog');
  res.send(layout({
    title: 'Colors', active: '/colors',
    body: html`
    <div class="page-head"><h1>Colors</h1></div>
    <p class="muted">Each color belongs to the supplier it comes from, because the same color name
    from two suppliers doesn't match. The price premium is added to the price of any panel or trim
    ordered in that color (use it for textured, metallic, PVDF and special-order colors). The same color name can be listed
    more than once for a supplier if it comes in more than one finish..</p>
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
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
      ${colorFields({}, suppliers, finishes)}
      <button class="btn primary">Add color</button>
    </form>` : html`<p class="card muted">Add a supplier first, then its colors.</p>`}
    <details class="card">
      <summary>Finishes: ${finishes.map((f) => f.label).join(', ')}</summary>
      <form method="post" action="/finishes" class="form-row" style="margin-top:.8rem">
        <label>New finish name<input name="label" required></label>
        <button class="btn">Add finish</button>
      </form>
    </details>` : ''}
    ${[...groups].map(([supplier, list]) => html`
      <h2>${supplier}</h2>
      <table class="list">
        <thead><tr><th>Color</th><th>Code</th><th>Finish</th><th>Stock or special</th><th class="num">Premium</th><th></th></tr></thead>
        <tbody>${list.map((c) => html`
          <tr class="${c.active ? '' : 'inactive'}"><td>${c.name}${c.active ? '' : html` <span class="muted small">(hidden)</span>`}</td>
          <td>${c.manufacturer_code}</td><td>${c.finish_label}</td>
          <td>${c.is_stock_color ? 'Stock' : 'Special order'}</td>
          <td class="num">${Number(c.upcharge_pct) ? `${Number(c.upcharge_pct)}%` : ''}</td>
          <td class="num">${edit ? html`<a href="/colors/${c.color_id}/edit">Edit</a>` : ''}</td></tr>`)}
        </tbody>
      </table>`)}
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
    await query(`INSERT INTO colors (supplier_id, name, manufacturer_code, finish, upcharge_pct, is_stock_color)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
    [c.supplier_id, c.name, c.manufacturer_code, c.finish, c.upcharge_pct, c.is_stock_color]);
    res.redirect('/colors');
  } catch (err) {
    res.redirect(`/colors?error=${encodeURIComponent(colorError(err, c))}`);
  }
});

router.get('/colors/:id(\\d+)/edit', need('catalog'), async (req, res) => {
  const { rows: [c] } = await query('SELECT * FROM colors WHERE color_id = $1', [req.params.id]);
  if (!c) return res.status(404).send('Color not found');
  const { rows: suppliers } = await query('SELECT * FROM suppliers ORDER BY name');
  const finishes = await loadFinishes();
  res.send(layout({
    title: `Edit ${c.name}`, active: '/colors',
    body: html`
    <h1>Edit color</h1>
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    <p class="muted">Changing the premium only affects new order lines. Orders already written keep their prices.</p>
    <form method="post" action="/colors/${c.color_id}" class="card form-row">
      ${colorFields(c, suppliers, finishes)}
      <label class="check"><input type="checkbox" name="active" value="1" ${c.active ? 'checked' : ''}> Show on new orders</label>
      <button class="btn primary">Save color</button>
      <a class="btn" href="/colors">Cancel</a>
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
    res.redirect('/colors');
  } catch (err) {
    res.redirect(`/colors/${req.params.id}/edit?error=${encodeURIComponent(colorError(err, c))}`);
  }
});

module.exports = router;
