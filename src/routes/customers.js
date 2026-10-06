const { query } = require('../db');
const { html, layout, money, date, statusBadge } = require('../html');

const router = require('../async-router')();

const TYPES = ['contractor', 'homeowner', 'commercial', 'dealer', 'other'];
const FIELDS = ['display_name', 'customer_type', 'company_name', 'first_name', 'last_name',
  'email', 'phone', 'mobile', 'payment_terms', 'default_fulfillment', 'resale_cert_number', 'notes'];

const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function customerForm(c, { action, error }) {
  const v = (k) => c[k] ?? '';
  const opt = (val, cur, label = val) =>
    html`<option value="${val}" ${val === cur ? 'selected' : ''}>${label}</option>`;
  return html`
  ${error ? html`<div class="alert">${error}</div>` : ''}
  <form method="post" action="${action}" class="card form-grid">
    <label class="span2">Customer name (as it should appear on invoices) *
      <input name="display_name" required maxlength="500" value="${v('display_name')}" autofocus></label>
    <label>Type
      <select name="customer_type">${TYPES.map((t) => opt(t, c.customer_type || 'contractor',
        t[0].toUpperCase() + t.slice(1)))}</select></label>
    <label>Company<input name="company_name" value="${v('company_name')}"></label>
    <label>First name<input name="first_name" value="${v('first_name')}"></label>
    <label>Last name<input name="last_name" value="${v('last_name')}"></label>
    <label>Phone<input name="phone" type="tel" value="${v('phone')}"></label>
    <label>Mobile<input name="mobile" type="tel" value="${v('mobile')}"></label>
    <label class="span2">Email<input name="email" type="email" value="${v('email')}"></label>
    <label>Payment terms<input name="payment_terms" value="${v('payment_terms') || 'Due on receipt'}"></label>
    <label>Usually
      <select name="default_fulfillment">
        ${opt('pickup', c.default_fulfillment || 'pickup', 'Picks up')}
        ${opt('delivery', c.default_fulfillment, 'Gets delivery')}
      </select></label>
    <label class="check"><input type="checkbox" name="tax_exempt" value="1" ${c.tax_exempt ? 'checked' : ''}> Tax exempt</label>
    <label>Resale certificate #<input name="resale_cert_number" value="${v('resale_cert_number')}"></label>
    <label class="span2">Notes<textarea name="notes" rows="3">${v('notes')}</textarea></label>
    <div class="span2 actions"><button class="btn primary">Save customer</button></div>
  </form>`;
}

function fromBody(body) {
  const c = {};
  for (const f of FIELDS) c[f] = clean(body[f]);
  c.customer_type = TYPES.includes(c.customer_type) ? c.customer_type : 'contractor';
  c.default_fulfillment = c.default_fulfillment === 'delivery' ? 'delivery' : 'pickup';
  c.payment_terms = c.payment_terms || 'Due on receipt';
  c.tax_exempt = body.tax_exempt === '1';
  return c;
}

const friendlyError = (err) => (err.code === '23505'
  ? 'Another customer already has that name. Customer names must be unique (QuickBooks requires it).'
  : err.message);

router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const { rows } = await query(`
    SELECT c.customer_id, c.display_name, c.customer_type, c.phone, c.email,
           count(o.order_id) FILTER (WHERE o.status NOT IN ('invoiced','cancelled')) AS open_orders,
           max(o.ordered_on) AS last_order
    FROM customers c LEFT JOIN orders o USING (customer_id)
    WHERE c.active AND ($1 = '' OR c.display_name ILIKE '%' || $1 || '%'
          OR c.company_name ILIKE '%' || $1 || '%' OR c.phone ILIKE '%' || $1 || '%')
    GROUP BY c.customer_id ORDER BY lower(c.display_name)`, [q]);
  res.send(layout({
    title: 'Customers', active: '/customers',
    body: html`
    <div class="page-head">
      <h1>Customers</h1>
      <a class="btn primary" href="/customers/new">+ New customer</a>
    </div>
    <form class="search"><input name="q" value="${q}" placeholder="Search by name or phone"><button class="btn">Search</button></form>
    <table class="list">
      <thead><tr><th>Name</th><th>Type</th><th>Phone</th><th>Email</th><th class="num">Open orders</th><th>Last order</th></tr></thead>
      <tbody>${rows.length ? rows.map((c) => html`
        <tr><td><a href="/customers/${c.customer_id}">${c.display_name}</a></td>
        <td>${c.customer_type}</td><td>${c.phone}</td><td>${c.email}</td>
        <td class="num">${c.open_orders || ''}</td><td>${date(c.last_order)}</td></tr>`)
      : html`<tr><td colspan="6" class="empty">No customers yet.</td></tr>`}</tbody>
    </table>`,
  }));
});

router.get('/new', (req, res) => {
  res.send(layout({
    title: 'New customer', active: '/customers',
    body: html`<h1>New customer</h1>${customerForm({}, { action: '/customers' })}`,
  }));
});

router.post('/', async (req, res) => {
  const c = fromBody(req.body);
  try {
    const { rows } = await query(`
      INSERT INTO customers (${FIELDS.join(', ')}, tax_exempt)
      VALUES (${FIELDS.map((_, i) => `$${i + 1}`).join(', ')}, $${FIELDS.length + 1})
      RETURNING customer_id`, [...FIELDS.map((f) => c[f]), c.tax_exempt]);
    res.redirect(`/customers/${rows[0].customer_id}`);
  } catch (err) {
    res.status(400).send(layout({
      title: 'New customer', active: '/customers',
      body: html`<h1>New customer</h1>${customerForm(c, { action: '/customers', error: friendlyError(err) })}`,
    }));
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  const { rows: [c] } = await query('SELECT * FROM customers WHERE customer_id = $1', [req.params.id]);
  if (!c) return res.status(404).send('Customer not found');
  const { rows: orders } = await query(`
    SELECT o.order_id, o.order_number, o.job_name, o.po_number, o.status, o.ordered_on, o.need_by,
           t.pre_tax_total
    FROM orders o JOIN v_order_totals t USING (order_id)
    WHERE o.customer_id = $1 ORDER BY o.ordered_on DESC, o.order_id DESC`, [c.customer_id]);
  const row = (label, v) => (v ? html`<dt>${label}</dt><dd>${v}</dd>` : '');
  res.send(layout({
    title: c.display_name, active: '/customers',
    body: html`
    <div class="page-head">
      <h1>${c.display_name}</h1>
      <div>
        <a class="btn" href="/customers/${c.customer_id}/edit">Edit</a>
        <a class="btn primary" href="/orders/new?customer_id=${c.customer_id}">+ New order</a>
      </div>
    </div>
    <div class="card"><dl class="details">
      ${row('Type', c.customer_type)}${row('Company', c.company_name)}
      ${row('Contact', [c.first_name, c.last_name].filter(Boolean).join(' '))}
      ${row('Phone', c.phone)}${row('Mobile', c.mobile)}${row('Email', c.email)}
      ${row('Terms', c.payment_terms)}${row('Usually', c.default_fulfillment === 'delivery' ? 'Gets delivery' : 'Picks up')}
      ${row('Tax', c.tax_exempt ? `Exempt${c.resale_cert_number ? ` (cert ${c.resale_cert_number})` : ''}` : 'Taxable')}
      ${row('Notes', c.notes)}
    </dl></div>
    <h2>Orders</h2>
    <table class="list">
      <thead><tr><th>Order #</th><th>Job</th><th>PO</th><th>Status</th><th>Ordered</th><th>Need by</th><th class="num">Total (pre-tax)</th></tr></thead>
      <tbody>${orders.length ? orders.map((o) => html`
        <tr><td><a href="/orders/${o.order_id}">${o.order_number}</a></td><td>${o.job_name}</td><td>${o.po_number}</td>
        <td>${statusBadge(o.status)}</td><td>${date(o.ordered_on)}</td><td>${date(o.need_by)}</td>
        <td class="num">${money(o.pre_tax_total)}</td></tr>`)
      : html`<tr><td colspan="7" class="empty">No orders yet.</td></tr>`}</tbody>
    </table>`,
  }));
});

router.get('/:id(\\d+)/edit', async (req, res) => {
  const { rows: [c] } = await query('SELECT * FROM customers WHERE customer_id = $1', [req.params.id]);
  if (!c) return res.status(404).send('Customer not found');
  res.send(layout({
    title: `Edit ${c.display_name}`, active: '/customers',
    body: html`<h1>Edit customer</h1>${customerForm(c, { action: `/customers/${c.customer_id}` })}`,
  }));
});

router.post('/:id(\\d+)', async (req, res) => {
  const c = fromBody(req.body);
  try {
    await query(`
      UPDATE customers SET ${FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')},
             tax_exempt = $${FIELDS.length + 1}
      WHERE customer_id = $${FIELDS.length + 2}`,
    [...FIELDS.map((f) => c[f]), c.tax_exempt, req.params.id]);
    res.redirect(`/customers/${req.params.id}`);
  } catch (err) {
    res.status(400).send(layout({
      title: 'Edit customer', active: '/customers',
      body: html`<h1>Edit customer</h1>${customerForm(c, { action: `/customers/${req.params.id}`, error: friendlyError(err) })}`,
    }));
  }
});

module.exports = router;
