// Admin dashboard: one place for users, prices and tax, products, colors and suppliers.
const { query, tx } = require('../db');
const { html, layout, money, num } = require('../html');
const { need } = require('../auth');
const mail = require('../mail');

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
      ${card('/admin/screws', 'Screws and clips', 'Which screws and clips go with each panel and framing, and how many.')}
      ${card('/admin/quickbooks', 'QuickBooks', 'Connect QuickBooks. Customers sync both ways; completed orders become invoices.')}
      ${card('/admin/email', 'Email', mail.configured() ? 'Email is set up. Send a test and see what the CRM has sent.'
    : 'Not set up yet. Customers get links you copy by hand.')}
      ${card('/admin/suppliers', 'Suppliers', `${c.suppliers} suppliers. Edit contact details or remove.`)}
    </div>`,
  }));
});

// ---------------------------------------------------------------------------
// Email: is it set up, send a test, and what went out lately
// ---------------------------------------------------------------------------
router.get('/admin/email', need('admin'), async (req, res) => {
  const { rows } = await query(`SELECT sent_at, to_address, subject, ok, error FROM email_log ORDER BY sent_at DESC LIMIT 25`);
  const when = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'medium', timeStyle: 'short' });
  res.send(layout({
    title: 'Email', active: '/admin',
    body: html`
    <h1>Email</h1>
    ${req.query.sent ? html`<div class="notice">Test email sent to ${req.query.sent}. Check that inbox (and its spam folder).</div>` : ''}
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    <div class="card">
    ${mail.configured() ? html`
      <p>Email is set up. The CRM sends from <strong>${process.env.MAIL_FROM || process.env.SMTP_USER}</strong>.</p>
      <form method="post" action="/admin/email/test" class="row">
        <label>Send a test email to<input name="to" type="email" required value="${req.user.email}"></label>
        <button class="btn primary">Send test</button>
      </form>`
    : html`<p>Email isn't set up yet. In Render, open the hpcm-crm web service, then Environment, and add
      <strong>SMTP_USER</strong> (the sending address) and <strong>SMTP_PASS</strong> (the 16-letter App Password, no spaces).
      Save, wait a few minutes for the site to restart, then come back here.</p>`}
    </div>
    <h2>Recently sent</h2>
    <table class="list">
      <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Result</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => html`<tr><td>${when(r.sent_at)}</td><td>${r.to_address}</td><td>${r.subject}</td>
        <td>${r.ok ? 'Sent' : html`<span class="missing-text">Failed</span><div class="muted small">${r.error}</div>`}</td></tr>`)
      : html`<tr><td colspan="4" class="empty">Nothing sent yet.</td></tr>`}</tbody>
    </table>`,
  }));
});

router.post('/admin/email/test', need('admin'), async (req, res) => {
  const to = String(req.body.to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.redirect('/admin/email?error=' + encodeURIComponent('Enter an email address.'));
  if (!mail.configured()) return res.redirect('/admin/email?error=' + encodeURIComponent('Email isn\'t set up yet.'));
  const ok = await mail.send({ to, subject: 'Test email from the HPCM CRM', kind: 'test',
    text: `This is a test from the HPCM CRM, sent by ${req.user.full_name}. If you can read this, email is working.` });
  if (ok) return res.redirect('/admin/email?sent=' + encodeURIComponent(to));
  const { rows: [last] } = await query("SELECT error FROM email_log WHERE kind = 'test' ORDER BY sent_at DESC LIMIT 1");
  res.redirect('/admin/email?error=' + encodeURIComponent(`The test didn't send: ${last ? last.error : 'unknown problem'}`));
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
      <label class="check"><input type="checkbox" name="track_stock" value="1" ${p.track_stock ? 'checked' : ''}> Count on hand (Supplies page)</label>
      <label class="check"><input type="checkbox" name="stock_by_color" value="1" ${p.stock_by_color ? 'checked' : ''}> Count each color separately</label>
      <label class="check"><input type="checkbox" name="is_rental" value="1" ${p.is_rental ? 'checked' : ''}> Tool rental (quantity on a quote = days)</label>
      <span></span>
      ${isNew ? '' : html`<label class="check"><input type="checkbox" name="active" value="1" ${p.active ? 'checked' : ''}> Show on new quotes</label>`}
      <div class="span2 actions"><button class="btn primary">${isNew ? 'Add product' : 'Save'}</button>
        <a class="btn" href="/admin/products">Cancel</a></div>
    </form>
    ${isNew ? '' : html`<p class="muted">Change the price on the <a href="/products">Price list</a> page so the price history is kept.
      Screws for this product: <a href="/admin/screws?for=${p.category === 'panel' && p.profile_id ? `p:${p.profile_id}` : `i:${p.product_id}`}">screw rules</a>.</p>
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
  track_stock: b.track_stock === '1',
  stock_by_color: b.track_stock === '1' && b.stock_by_color === '1',
  is_rental: b.is_rental === '1',
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
  'max_length_in', 'girth_in', 'is_cut_to_length', 'taxable', 'track_stock', 'stock_by_color', 'is_rental'];

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
// Screw rules: which screw quotes get for each kind of panel and framing
// ---------------------------------------------------------------------------
const FRAMING = { any: 'Any framing', wood: 'Wood framing', steel: 'Steel framing' };
const SYSTEM = { any: 'Any panels', through_fastened: 'Through-fastener panels', concealed: 'Standing seam' };
const PER = [['square', 'square (100 sq ft)'], ['each', 'piece (each)'],
  ...[6, 9, 12, 18, 24, 36, 48].map((n) => [String(n), `every ${n % 12 ? `${n}"` : `${n / 12}'`}`])];

router.get('/admin/screws', need('screws'), async (req, res) => {
  const [kind, forId] = String(req.query.for || '').split(':');
  const only = ['p', 'i'].includes(kind) && Number(forId) ? { kind, id: Number(forId) } : null;
  const { rows: rules } = await query(`
    SELECT r.*, pp.name AS profile_name, ip.name AS item_name, ip.category AS item_category,
           p.name AS product_name, p.pricing_unit, p.pack_size, cp.unit_price
    FROM screw_rules r
    LEFT JOIN panel_profiles pp ON pp.profile_id = r.profile_id
    LEFT JOIN products ip ON ip.product_id = r.item_product_id
    LEFT JOIN products p ON p.product_id = r.product_id
    LEFT JOIN v_current_prices cp ON cp.product_id = r.product_id
    WHERE ($1::text IS NULL OR ($1 = 'p' AND r.profile_id = $2) OR ($1 = 'i' AND r.item_product_id = $2))
    ORDER BY r.profile_id IS NULL, pp.name, ip.name, r.framing, r.panel_system, r.sort_order, r.screw_rule_id`,
  [only ? only.kind : null, only ? only.id : null]);
  const { rows: profiles } = await query('SELECT profile_id, name FROM panel_profiles WHERE active ORDER BY name');
  const { rows: items } = await query(`SELECT product_id, name FROM products
    WHERE active AND category NOT IN ('panel', 'fastener', 'service', 'delivery')
    ORDER BY array_position(enum_range(NULL::product_category), category), name`);
  const { rows: parts } = await query(`SELECT product_id, name FROM products
    WHERE category IN ('fastener', 'accessory') AND active ORDER BY category DESC, name`);
  const opt = (v, cur, label) => html`<option value="${v}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${label}</option>`;
  const forOf = (r) => (r.profile_id ? `p:${r.profile_id}` : r.item_product_id ? `i:${r.item_product_id}` : '');
  const perOf = (r) => (r.basis === 'spacing' ? String(Number(r.spacing_in)) : r.basis || 'square');
  const fields = (r = {}) => html`
      <label>For<select name="for" required>
        <optgroup label="Panels">${profiles.map((p) => opt(`p:${p.profile_id}`, forOf(r), p.name))}</optgroup>
        <optgroup label="Trim and accessories">${items.map((p) => opt(`i:${p.product_id}`, forOf(r), p.name))}</optgroup>
      </select></label>
      <label>Framing<select name="framing">${Object.entries(FRAMING).map(([k, v]) => opt(k, r.framing || 'any', v))}</select></label>
      <label>With<select name="panel_system">${Object.entries(SYSTEM).map(([k, v]) => opt(k, r.panel_system || 'any', v))}</select></label>
      <label>Screw or clip<select name="product_id">
        <option value="" ${r.product_id || !r.item_product_id ? '' : 'selected'}>Same screw as the panels</option>
        ${parts.map((p) => opt(p.product_id, r.product_id, p.name))}</select></label>
      <label>How many<input name="qty" type="number" step="0.01" min="0.01" value="${r.qty ?? ''}" required style="width:5rem"></label>
      <label>Per<select name="per">${PER.map(([k, v]) => opt(k, perOf(r), v))}</select></label>
      <label>Choice name<input name="choice" value="${r.length_label || r.option_label}" placeholder='none' style="width:7rem"></label>
      <label>Per bag<input name="pack_size" type="number" step="1" min="1" value="${r.pack_size ?? ''}" placeholder="each" style="width:5rem"></label>
      <label class="check"><input type="checkbox" name="color_match" value="1" ${r.color_match !== false ? 'checked' : ''}> Match color</label>
      <label class="check"><input type="checkbox" name="is_default" value="1" ${r.is_default ? 'checked' : ''}> Usual choice</label>`;
  const groups = new Map();
  for (const r of rules) {
    const name = r.profile_name || r.item_name;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(r);
  }
  const noRules = only ? [] : profiles.filter((p) => !rules.some((r) => r.profile_id === p.profile_id)).map((p) => p.name);
  const back = only ? `?for=${only.kind}:${only.id}` : '';
  res.send(layout({
    title: 'Screws', active: '/admin',
    body: html`
    <div class="page-head"><h1>Screws and clips${only && groups.size ? `: ${[...groups.keys()][0]}` : ''}</h1>
      ${only ? html`<div class="actions"><a class="btn" href="/admin/screws">All rules</a></div>` : ''}</div>
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    ${req.query.saved ? html`<div class="notice">Saved.</div>` : ''}
    <details class="card"><summary>How these rules work</summary>
      <ul class="muted">
        <li>New quotes add screws and clips from their panels, trim and accessories using these rules.
          Each piece is rounded up (a 10' piece with screws every 18" gets 7 spots), then totals round up to whole bags.</li>
        <li><strong>Panels:</strong> "Framing" picks wood or steel; a <strong>choice name</strong> (like 1.5") makes it one of the
          lengths the quote can pick, and "Usual choice" is the one picked unless someone changes it.</li>
        <li><strong>Trim and accessories:</strong> "With" says which panels the rule goes with; the quote picks which screws its trim
          gets. "Same screw as the panels" follows the quote's framing and length. A <strong>choice name</strong> (like every 18")
          puts a choice on the quote line.</li>
        <li>Screws match the color of the line they're for. Trim screws are their own lines.</li>
      </ul></details>
    ${noRules.length ? html`<div class="alert">No rules yet for ${noRules.join(', ')}: those panels get no screws.</div>` : ''}
    ${[...groups].map(([name, list]) => html`
    <h2>${name}</h2>
    ${list.map((r) => html`
    <form method="post" action="/admin/screws/${r.screw_rule_id}${back}" class="card form-row">
      ${fields(r)}
      <span class="muted small">${!r.product_id ? '' : r.unit_price === null ? html`<span class="missing-text">No price</span>`
    : `${money(r.unit_price)}${r.pricing_unit === 'bag' ? '/bag' : ' each'}`}</span>
      <button class="btn">Save</button>
      <button class="btn danger" name="remove" value="1" onclick="return confirm('Remove this rule?')">Remove</button>
    </form>`)}`)}
    ${only && !groups.size ? html`<p class="muted">No screw rules for this product yet.</p>` : ''}
    <h2>Add a rule</h2>
    <form method="post" action="/admin/screws${back}" class="card form-row">${fields(only ? {
    profile_id: only.kind === 'p' ? only.id : null, item_product_id: only.kind === 'i' ? only.id : null,
    panel_system: only.kind === 'i' ? 'through_fastened' : 'any', basis: only.kind === 'i' ? 'spacing' : 'square', spacing_in: 24,
  } : {})}<button class="btn primary">Add</button></form>
    <p class="muted">A screw or clip that isn't listed? An Admin can add it as a product first (Admin &gt; Products).</p>`,
  }));
});

async function saveScrewRule(id, b) {
  const [kind, forId] = String(b.for || '').split(':');
  const per = String(b.per || 'square');
  const choice = String(b.choice || '').trim() || null;
  const isPanel = kind === 'p';
  const r = {
    profile_id: isPanel ? Number(forId) : null,
    item_product_id: kind === 'i' ? Number(forId) : null,
    framing: FRAMING[b.framing] ? b.framing : 'any',
    panel_system: !isPanel && SYSTEM[b.panel_system] ? b.panel_system : 'any',
    length_label: isPanel ? choice : null,
    option_label: isPanel ? null : choice,
    product_id: Number(b.product_id) || null,
    basis: per === 'square' || per === 'each' ? per : 'spacing',
    qty: Number(b.qty),
    spacing_in: per === 'square' || per === 'each' ? null : Number(per),
    color_match: b.color_match === '1',
    is_default: b.is_default === '1' && Boolean(choice),
    pack: String(b.pack_size || '').trim() === '' ? null : Math.round(Number(b.pack_size)),
  };
  if (!(r.profile_id || r.item_product_id) || !(r.qty > 0)) return 'Pick what the rule is for and enter how many.';
  if (isPanel && !r.product_id) return 'Panel rules need a screw or clip picked.';
  if (isPanel && r.basis === 'each') return 'Panel rules count per square or along the panel, not per piece.';
  if (!isPanel && r.basis === 'square') return 'Trim and accessory rules count along each piece or per piece, not per square.';
  if (r.pack !== null && !(r.pack > 0)) return 'Per bag must be a whole number.';
  const cols = ['profile_id', 'item_product_id', 'framing', 'panel_system', 'length_label', 'option_label', 'product_id',
    'basis', 'qty', 'spacing_in', 'color_match', 'is_default'];
  try {
    await tx(async (db) => {
      const { rows: [row] } = id
        ? await db.query(`UPDATE screw_rules SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
            WHERE screw_rule_id = $1 RETURNING screw_rule_id`, [id, ...cols.map((c) => r[c])])
        : await db.query(`INSERT INTO screw_rules (${cols.join(', ')}, sort_order)
            VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, (SELECT COALESCE(max(sort_order), 0) + 1 FROM screw_rules))
            RETURNING screw_rule_id`, cols.map((c) => r[c]));
      // One usual choice per panel (and framing) or product (and panels).
      if (r.is_default) {
        await db.query(`UPDATE screw_rules SET is_default = false
          WHERE screw_rule_id <> $1 AND COALESCE(profile_id, 0) = COALESCE($2, 0) AND COALESCE(item_product_id, 0) = COALESCE($3, 0)
            AND framing = $4 AND panel_system = $5`,
        [row.screw_rule_id, r.profile_id, r.item_product_id, r.framing, r.panel_system]);
      }
      if (r.pack && r.product_id) await db.query('UPDATE products SET pack_size = $2 WHERE product_id = $1', [r.product_id, r.pack]);
    });
  } catch (err) {
    if (err.code === '23505') return 'That rule is already there.';
    throw err;
  }
  return null;
}

const screwsBack = (req, err) => {
  const params = new URLSearchParams();
  if (req.query.for) params.set('for', req.query.for);
  params.set(err ? 'error' : 'saved', err || '1');
  return `/admin/screws?${params}`;
};

router.post('/admin/screws', need('screws'), async (req, res) => {
  res.redirect(screwsBack(req, await saveScrewRule(null, req.body)));
});

router.post('/admin/screws/:id(\\d+)', need('screws'), async (req, res) => {
  if (req.body.remove === '1') {
    await query('DELETE FROM screw_rules WHERE screw_rule_id = $1', [req.params.id]);
    return res.redirect(screwsBack(req));
  }
  res.redirect(screwsBack(req, await saveScrewRule(Number(req.params.id), req.body)));
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
