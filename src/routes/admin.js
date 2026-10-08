// Admin dashboard: one place for users, prices and tax, products, colors and suppliers.
const { query, tx } = require('../db');
const { html, layout, money, num } = require('../html');
const { need } = require('../auth');

const router = require('../async-router')();

const CATEGORIES = {
  panel: 'Panel', custom_trim: 'Custom trim', trim: 'Trim / specialty cut', flat_sheet: 'Flat sheet',
  downspout: 'Downspout or elbow', boot: 'Boot', jack: 'Jack', fastener: 'Screws / fasteners',
  accessory: 'Accessory', service: 'Service', delivery: 'Delivery',
};
const UNITS = { sqft: 'per sq ft', lf: 'per linear foot', each: 'each', bag: 'per bag', roll: 'per roll' };

router.get('/admin', need('admin'), async (req, res) => {
  const { rows: [c] } = await query(`SELECT
    (SELECT count(*) FROM users WHERE active)::int AS users,
    (SELECT count(*) FROM products WHERE active)::int AS products,
    (SELECT count(*) FROM colors WHERE active)::int AS colors,
    (SELECT count(*) FROM suppliers)::int AS suppliers,
    (SELECT value FROM app_settings WHERE key = 'sales_tax_rate') AS tax`);
  const card = (href, title, text) => html`<a class="card admin-card" href="${href}"><h2>${title}</h2><p>${text}</p></a>`;
  res.send(layout({
    title: 'Admin', active: '/admin',
    body: html`
    <h1>Admin</h1>
    <div class="admin-grid">
      ${card('/users', 'Users and access', `${c.users} people can sign in. Add people, reset passwords, set what each can do.`)}
      ${card('/products', 'Prices and sales tax', `Change prices and flat widths. Sales tax for new quotes: ${num(c.tax, 3)}%.`)}
      ${card('/admin/products', 'Products', `${c.products} products. Add new ones, rename, change units, or remove.`)}
      ${card('/colors', 'Colors and finishes', `${c.colors} colors. Add colors, premiums and finishes.`)}
      ${card('/admin/suppliers', 'Suppliers', `${c.suppliers} suppliers. Edit contact details or remove.`)}
    </div>`,
  }));
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
router.get('/admin/products', need('catalog'), async (req, res) => {
  const { rows } = await query(`
    SELECT p.product_id, p.sku, p.name, p.category, p.pricing_unit, p.active, cp.unit_price,
           EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = p.product_id) AS used
    FROM products p LEFT JOIN v_current_prices cp USING (product_id)
    ORDER BY p.active DESC, array_position(enum_range(NULL::product_category), p.category), p.name`);
  res.send(layout({
    title: 'Products', active: '/admin',
    body: html`
    <div class="page-head"><h1>Products</h1>
      <div class="actions"><a class="btn primary" href="/admin/products/new">+ Add product</a></div></div>
    ${req.query.saved ? html`<div class="notice">Saved.</div>` : ''}
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    <p class="muted">Removing a product that's already on orders hides it from new quotes instead, so old
      orders keep it.</p>
    <table class="list">
      <thead><tr><th>Product</th><th>Type</th><th>Priced</th><th class="num">Price</th><th></th></tr></thead>
      <tbody>${rows.map((p) => html`<tr class="${p.active ? '' : 'inactive'}">
        <td>${p.name}${p.active ? '' : html` <span class="muted small">(hidden)</span>`}<div class="muted small">${p.sku}</div></td>
        <td>${CATEGORIES[p.category] || p.category}</td><td>${UNITS[p.pricing_unit]}</td>
        <td class="num">${money(p.unit_price)}</td>
        <td class="num"><a class="btn small" href="/admin/products/${p.product_id}">Edit</a></td></tr>`)}</tbody>
    </table>`,
  }));
});

async function productForm(res, p, error) {
  const { rows: profiles } = await query('SELECT profile_id, name FROM panel_profiles ORDER BY name');
  const { rows: gauges } = await query('SELECT gauge_id, gauge FROM gauges ORDER BY gauge');
  const isNew = !p.product_id;
  const opt = (v, cur, label) => html`<option value="${v}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${label}</option>`;
  res.status(error ? 400 : 200).send(layout({
    title: isNew ? 'Add product' : p.name, active: '/admin',
    body: html`
    <h1>${isNew ? 'Add product' : `Edit ${p.name}`}</h1>
    ${error ? html`<div class="alert">${error}</div>` : ''}
    <form method="post" action="${isNew ? '/admin/products' : `/admin/products/${p.product_id}`}" class="card form-grid" style="max-width:760px">
      <label class="span2">Name *<input name="name" value="${p.name}" required></label>
      <label>Type *<select name="category">${Object.entries(CATEGORIES).map(([k, v]) => opt(k, p.category || 'trim', v))}</select></label>
      <label>Priced *<select name="pricing_unit">${Object.entries(UNITS).map(([k, v]) => opt(k, p.pricing_unit || 'each', v))}</select></label>
      <label>Panel profile (panels only)<select name="profile_id"><option value="">None</option>
        ${profiles.map((r) => opt(r.profile_id, p.profile_id, r.name))}</select></label>
      <label>Gauge<select name="gauge_id"><option value="">None</option>
        ${gauges.map((g) => opt(g.gauge_id, p.gauge_id, `${g.gauge} ga`))}</select></label>
      <label>Price is for a piece this long (ft)<input name="standard_ft" type="number" step="0.01" min="0"
        value="${p.standard_length_in ? num(p.standard_length_in / 12, 3) : ''}" placeholder="e.g. 10 for trim"></label>
      <label>Longest piece we can make (ft)<input name="max_ft" type="number" step="0.01" min="0"
        value="${p.max_length_in ? num(p.max_length_in / 12, 3) : ''}"></label>
      <label>Flat width (inches of coil)<input name="girth_in" type="number" step="0.125" min="0" value="${p.girth_in ?? ''}"></label>
      <label>SKU<input name="sku" value="${p.sku}" placeholder="made from the name if blank"></label>
      ${isNew ? html`<label>Price<input name="unit_price" type="number" step="0.01" min="0" placeholder="leave blank if it varies"></label>` : ''}
      <label class="check"><input type="checkbox" name="is_cut_to_length" value="1" ${p.is_cut_to_length ? 'checked' : ''}> Every line needs a length</label>
      <label class="check"><input type="checkbox" name="taxable" value="1" ${p.taxable !== false ? 'checked' : ''}> Taxable</label>
      ${isNew ? '' : html`<label class="check"><input type="checkbox" name="active" value="1" ${p.active ? 'checked' : ''}> Show on new quotes</label>`}
      <div class="span2 actions"><button class="btn primary">${isNew ? 'Add product' : 'Save'}</button>
        <a class="btn" href="/admin/products">Cancel</a></div>
    </form>
    ${isNew ? '' : html`<p class="muted">Change the price on the <a href="/products">Price list</a> page so the price history is kept.</p>
    <form method="post" action="/admin/products/${p.product_id}/remove"
      onsubmit="return confirm('Remove this product?')"><button class="btn danger">Remove product</button></form>`}`,
  }));
}

const optNum = (v, mult = 1) => (v === undefined || String(v).trim() === '' ? null : Number(v) * mult);
const productFromBody = (b) => ({
  name: String(b.name || '').trim(),
  sku: String(b.sku || '').trim(),
  category: CATEGORIES[b.category] ? b.category : 'trim',
  pricing_unit: UNITS[b.pricing_unit] ? b.pricing_unit : 'each',
  profile_id: optNum(b.profile_id),
  gauge_id: optNum(b.gauge_id),
  standard_length_in: optNum(b.standard_ft, 12),
  max_length_in: optNum(b.max_ft, 12),
  girth_in: optNum(b.girth_in),
  is_cut_to_length: b.is_cut_to_length === '1',
  taxable: b.taxable === '1',
  active: b.active === '1',
});
const makeSku = (name) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function productProblem(p) {
  if (!p.name) return 'Enter a name.';
  if (p.category === 'panel' && (!p.profile_id || !p.gauge_id)) return 'A panel needs a profile and a gauge.';
  if (p.category === 'custom_trim' && p.pricing_unit !== 'sqft') return 'Custom trim is priced per sq ft.';
  for (const k of ['standard_length_in', 'max_length_in', 'girth_in']) {
    if (p[k] !== null && !(p[k] > 0)) return 'Lengths and widths must be more than zero.';
  }
  return null;
}
const dbProblem = (err) => (err.code === '23505' ? 'Another product already uses that SKU.'
  : err.code === '23514' ? 'Those settings don\'t fit together (a panel needs a profile and gauge; custom trim is per sq ft).' : null);

const COLS = ['name', 'sku', 'category', 'pricing_unit', 'profile_id', 'gauge_id', 'standard_length_in',
  'max_length_in', 'girth_in', 'is_cut_to_length', 'taxable'];

router.get('/admin/products/new', need('catalog'), (req, res) => productForm(res, { taxable: true }));

router.post('/admin/products', need('catalog'), async (req, res) => {
  const p = productFromBody(req.body);
  p.sku ||= makeSku(p.name);
  const problem = productProblem(p);
  if (problem) return productForm(res, p, problem);
  const price = optNum(req.body.unit_price);
  try {
    await tx(async (db) => {
      const { rows: [r] } = await db.query(`INSERT INTO products (${COLS.join(', ')}, price_varies)
        VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')}, $${COLS.length + 1}) RETURNING product_id`,
      [...COLS.map((c) => p[c]), price === null]);
      if (price !== null) {
        await db.query(`INSERT INTO product_prices (product_id, unit_price, effective_from, source)
          VALUES ($1, $2, current_date, 'Added in CRM')`, [r.product_id, price]);
      }
    });
  } catch (err) {
    const msg = dbProblem(err);
    if (!msg) throw err;
    return productForm(res, p, msg);
  }
  res.redirect('/admin/products?saved=1');
});

router.get('/admin/products/:id(\\d+)', need('catalog'), async (req, res) => {
  const { rows: [p] } = await query('SELECT * FROM products WHERE product_id = $1', [req.params.id]);
  if (!p) return res.status(404).send('Product not found');
  productForm(res, p);
});

router.post('/admin/products/:id(\\d+)', need('catalog'), async (req, res) => {
  const p = { ...productFromBody(req.body), product_id: Number(req.params.id) };
  p.sku ||= makeSku(p.name);
  const problem = productProblem(p);
  if (problem) return productForm(res, p, problem);
  try {
    await query(`UPDATE products SET ${COLS.map((c, i) => `${c} = $${i + 1}`).join(', ')}, active = $${COLS.length + 1}
      WHERE product_id = $${COLS.length + 2}`, [...COLS.map((c) => p[c]), p.active, p.product_id]);
  } catch (err) {
    const msg = dbProblem(err);
    if (!msg) throw err;
    return productForm(res, p, msg);
  }
  res.redirect('/admin/products?saved=1');
});

// Delete if no order or stock uses it; otherwise hide it from new quotes.
router.post('/admin/products/:id(\\d+)/remove', need('catalog'), async (req, res) => {
  try {
    await query('DELETE FROM products WHERE product_id = $1', [req.params.id]);
    res.redirect('/admin/products?saved=1');
  } catch (err) {
    if (err.code !== '23503') throw err;
    await query('UPDATE products SET active = false WHERE product_id = $1', [req.params.id]);
    res.redirect(`/admin/products?error=${encodeURIComponent('That product is on existing orders or stock, so it was hidden from new quotes instead.')}`);
  }
});

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------
router.get('/admin/suppliers', need('catalog'), async (req, res) => {
  const { rows } = await query(`SELECT s.*, (SELECT count(*) FROM colors c WHERE c.supplier_id = s.supplier_id)::int AS colors
    FROM suppliers s ORDER BY s.name`);
  res.send(layout({
    title: 'Suppliers', active: '/admin',
    body: html`
    <h1>Suppliers</h1>
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    <p class="muted">Add new suppliers on the <a href="/colors">Colors</a> page. A supplier with colors can't be
      removed; hide its colors instead.</p>
    ${rows.map((s) => html`
    <form method="post" action="/admin/suppliers/${s.supplier_id}" class="card form-row">
      <label>Name<input name="name" value="${s.name}" required></label>
      <label>Phone<input name="phone" value="${s.phone}" type="tel"></label>
      <label>Email<input name="email" value="${s.email}" type="email"></label>
      <span class="muted small">${s.colors} colors</span>
      <button class="btn">Save</button>
      ${s.colors ? '' : html`<button class="btn danger" name="remove" value="1"
        onclick="return confirm('Remove this supplier?')">Remove</button>`}
    </form>`)}`,
  }));
});

router.post('/admin/suppliers/:id(\\d+)', need('catalog'), async (req, res) => {
  const b = req.body;
  const back = (msg) => res.redirect(`/admin/suppliers${msg ? `?error=${encodeURIComponent(msg)}` : ''}`);
  try {
    if (b.remove === '1') {
      await query('DELETE FROM suppliers WHERE supplier_id = $1', [req.params.id]);
    } else {
      await query('UPDATE suppliers SET name = $2, phone = $3, email = $4 WHERE supplier_id = $1',
        [req.params.id, String(b.name || '').trim(), String(b.phone || '').trim() || null, String(b.email || '').trim() || null]);
    }
  } catch (err) {
    if (err.code === '23503') return back('That supplier still has colors or coils, so it can\'t be removed.');
    if (err.code === '23505') return back('Another supplier already has that name.');
    throw err;
  }
  back();
});

module.exports = router;
