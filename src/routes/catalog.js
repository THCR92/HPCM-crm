// Price list and colors.
const { query } = require('../db');
const { html, layout, money, date, UNIT_LABEL } = require('../html');

const router = require('../async-router')();

const CATEGORY_LABEL = {
  panel: 'Panels', custom_trim: 'Custom trim', trim: 'Trims & specialty cuts', flat_sheet: 'Flat sheet',
  boot: 'Boots', jack: 'Jacks', fastener: 'Screws', accessory: 'Accessories',
  service: 'Services', delivery: 'Delivery',
};

router.get('/products', async (req, res) => {
  const { rows } = await query(`
    SELECT p.product_id, p.sku, p.name, p.category, p.pricing_unit, p.price_varies,
           cp.unit_price, cp.effective_from
    FROM products p LEFT JOIN v_current_prices cp USING (product_id)
    WHERE p.active ORDER BY array_position(enum_range(NULL::product_category), p.category), p.name`);
  const groups = {};
  for (const r of rows) (groups[r.category] ||= []).push(r);
  res.send(layout({
    title: 'Price list', active: '/products',
    body: html`
    <div class="page-head"><h1>Price list</h1></div>
    <p class="muted">Prices are for standard stock colors. Change a price here and new order lines use it
    from today on; orders already written keep the price they were written at.</p>
    ${req.query.saved ? html`<div class="notice">Price saved.</div>` : ''}
    ${Object.entries(groups).map(([cat, items]) => html`
      <h2>${CATEGORY_LABEL[cat] || cat}</h2>
      <table class="list">
        <thead><tr><th>Product</th><th>Unit</th><th class="num">Price</th><th>Since</th><th></th></tr></thead>
        <tbody>${items.map((p) => html`
          <tr><td>${p.name}<div class="muted small">${p.sku}</div></td>
          <td>${UNIT_LABEL[p.pricing_unit]}</td>
          <td class="num">${p.unit_price !== null ? money(p.unit_price) : html`<span class="muted">${p.price_varies ? 'Varies' : '—'}</span>`}</td>
          <td>${date(p.effective_from)}</td>
          <td><form method="post" action="/products/${p.product_id}/price" class="inline">
            <input name="unit_price" type="number" step="0.01" min="0" placeholder="New price" required>
            <button class="btn small">Set</button></form></td></tr>`)}
        </tbody>
      </table>`)}`,
  }));
});

router.post('/products/:id(\\d+)/price', async (req, res) => {
  const price = Number(req.body.unit_price);
  if (!(price >= 0)) return res.status(400).send('Enter a valid price');
  await query(`
    INSERT INTO product_prices (product_id, unit_price, effective_from, source)
    VALUES ($1, $2, current_date, 'Edited in CRM')
    ON CONFLICT (product_id, effective_from) DO UPDATE SET unit_price = EXCLUDED.unit_price`,
  [req.params.id, price]);
  res.redirect('/products?saved=1');
});

router.get('/colors', async (req, res) => {
  const { rows } = await query('SELECT * FROM colors ORDER BY active DESC, name');
  res.send(layout({
    title: 'Colors', active: '/colors',
    body: html`
    <div class="page-head"><h1>Colors</h1></div>
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    <form method="post" action="/colors" class="card form-row">
      <label>Color name<input name="name" required></label>
      <label>Manufacturer code<input name="manufacturer_code"></label>
      <label class="check"><input type="checkbox" name="special" value="1"> Special order</label>
      <label>Upcharge %<input name="upcharge" type="number" step="0.01" min="0" value="0"></label>
      <button class="btn primary">Add color</button>
    </form>
    <table class="list">
      <thead><tr><th>Color</th><th>Code</th><th>Stock or special</th><th class="num">Upcharge</th></tr></thead>
      <tbody>${rows.length ? rows.map((c) => html`
        <tr><td>${c.name}</td><td>${c.manufacturer_code}</td>
        <td>${c.is_stock_color ? 'Stock' : 'Special order'}</td>
        <td class="num">${c.is_stock_color ? '' : `${Number(c.special_order_upcharge_pct)}%`}</td></tr>`)
      : html`<tr><td colspan="4" class="empty">No colors yet. Add your stock colors above.</td></tr>`}</tbody>
    </table>`,
  }));
});

router.post('/colors', async (req, res) => {
  const name = (req.body.name || '').trim();
  const special = req.body.special === '1';
  try {
    await query(`INSERT INTO colors (name, manufacturer_code, is_stock_color, special_order_upcharge_pct)
                 VALUES ($1, $2, $3, $4)`,
    [name, (req.body.manufacturer_code || '').trim() || null, !special,
      special ? Number(req.body.upcharge) || 0 : 0]);
    res.redirect('/colors');
  } catch (err) {
    const msg = err.code === '23505' ? `${name} is already on the list.` : err.message;
    res.redirect(`/colors?error=${encodeURIComponent(msg)}`);
  }
});

module.exports = router;
