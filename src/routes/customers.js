const crypto = require('crypto');
const { query } = require('../db');
const { html, layout, money, date, statusBadge, deleteButton, typedDelete } = require('../html');
const { can, need, isAdmin, userName } = require('../auth');
const qbo = require('../qbo');

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

// Where this customer stands with QuickBooks (only once QuickBooks is connected).
async function qboRow(c) {
  if (!(await qbo.connected())) return '';
  const retry = can('customers') ? html` <form method="post" action="/customers/${c.customer_id}/qbo" class="inline">
    <button class="btn small">Send to QuickBooks</button></form>` : '';
  if (c.qbo_last_error) return html`<dt>QuickBooks</dt><dd><span class="warn-text">Not updated: ${c.qbo_last_error}</span>${retry}</dd>`;
  if (c.qbo_customer_id) return html`<dt>QuickBooks</dt><dd>Matched${c.qbo_synced_at ? `, last synced ${date(c.qbo_synced_at)}` : ''}</dd>`;
  return html`<dt>QuickBooks</dt><dd>Not in QuickBooks yet${retry}</dd>`;
}

// ---------------------------------------------------------------------------
// Customer portal: on/off, which prices they see, and their logins. Logins get a
// link to set their own password (no email is sent: copy it into a text or email).
// ---------------------------------------------------------------------------
const linkFor = (req, token) => `${req.protocol}://${req.get('host')}/portal/set-password/${token}`;
const newToken = () => crypto.randomBytes(24).toString('base64url');
const { INVITE_DAYS } = require('./portal-shared');
const mail = require('../mail');
const notices = require('../notices');

// Emails the login its set-password link (a fresh one if it has none). Returns true if sent.
async function emailLink(req, customerId, loginId) {
  const { rows: [l] } = await query(`
    UPDATE customer_logins SET invite_token = CASE WHEN invite_expires_at > now() THEN invite_token ELSE $3 END,
           invite_expires_at = CASE WHEN invite_expires_at > now() THEN invite_expires_at ELSE now() + make_interval(days => $4) END
    WHERE login_id = $2 AND customer_id = $1 AND active RETURNING *`, [customerId, loginId, newToken(), INVITE_DAYS]);
  if (!l) return false;
  return notices.passwordLink(l, linkFor(req, l.invite_token), { reset: Boolean(l.password_hash) });
}

async function portalCard(c, req) {
  if (!can('portal') && !c.portal_enabled) return '';
  const { rows: logins } = await query(`SELECT *, invite_expires_at > now() AS link_ok FROM customer_logins
    WHERE customer_id = $1 ORDER BY active DESC, full_name`, [c.customer_id]);
  const edit = can('portal');
  const shown = [c.portal_line_prices && 'line prices', c.portal_totals && 'order totals'].filter(Boolean);
  const linkBox = (l) => {
    if (!l.invite_token || !l.link_ok) return '';
    const url = linkFor(req, l.invite_token);
    const subject = 'Your High Plains Custom Metal customer login';
    const body = `Hi ${l.full_name.split(' ')[0]},\n\nYou can now see your quotes and orders with High Plains Custom Metal online, `
      + `and approve quotes there. Open this link to set your password (it works for ${INVITE_DAYS} days):\n\n${url}\n\n`
      + 'After that, sign in any time at ' + `${req.protocol}://${req.get('host')}/portal` + '\n\nThank you,\nHigh Plains Custom Metal\n(307) 331-6449';
    const gmail = `https://mail.google.com/mail/?${new URLSearchParams({ authuser: req.user.email, view: 'cm', fs: '1', to: l.email, su: subject, body })}`;
    return html`<div class="invite-link">
      <span class="muted small">${l.password_hash ? 'Password reset link' : 'Invite link'}, good until ${date(l.invite_expires_at)}
        (making a new one stops this one working):</span>
      <input readonly value="${url}" onclick="this.select()">
      <button type="button" class="btn small" onclick="navigator.clipboard.writeText(this.previousElementSibling.value); this.textContent = 'Copied'">Copy</button>
      ${mail.configured() ? html`<form method="post" action="/customers/${c.customer_id}/logins/${l.login_id}/email" class="inline">
        <button class="btn small">Email it to them</button></form>`
    : html`<a class="btn small" href="${gmail}" target="_blank" rel="noopener">Email with Gmail</a>`}</div>`;
  };
  return html`
  <section class="card" id="portal">
    <h2>Customer portal ${c.portal_enabled ? html`<span class="badge badge-completed">On</span>` : html`<span class="badge badge-quote">Off</span>`}</h2>
    ${req.query.portal_error ? html`<div class="alert">${req.query.portal_error}</div>` : ''}
    ${req.query.emailed ? html`<div class="notice">Emailed the link to ${req.query.emailed}.</div>` : ''}
    ${!c.portal_enabled && logins.some((l) => l.active) ? html`<div class="alert">The portal is off for this customer, so their login and links won't work. Tick "Portal on" and Save.</div>` : ''}
    <p class="muted small">Customers sign in at <strong>${req.get('host')}/portal</strong> to see their quotes and orders and approve quotes.
      Quotes they approve still need your approval here. ${c.portal_enabled ? `They see ${shown.length ? shown.join(' and ') : 'no prices'}.` : ''}</p>
    ${edit ? html`<form method="post" action="/customers/${c.customer_id}/portal" class="portal-settings" onchange="this.submit()">
      <label class="check"><input type="checkbox" name="enabled" value="1" ${c.portal_enabled ? 'checked' : ''}> Portal on for this customer</label>
      <label class="check"><input type="checkbox" name="line_prices" value="1" ${c.portal_line_prices ? 'checked' : ''}> Show line prices</label>
      <label class="check"><input type="checkbox" name="totals" value="1" ${c.portal_totals ? 'checked' : ''}> Show order totals</label>
      <noscript><button class="btn small">Save</button></noscript><span class="muted small">Saves when you tick a box.</span></form>` : ''}
    ${logins.map((l) => html`<table class="list">
      <thead><tr><th>Login</th><th>Email</th><th>Last signed in</th><th></th></tr></thead>
      <tbody><tr class="${l.active ? '' : 'muted'}">
        <td>${l.full_name}${l.active ? '' : ' (turned off)'}${l.password_hash ? '' : html` <span class="muted small">· hasn't set a password yet</span>`}</td>
        <td>${l.email}</td><td>${l.last_login_at ? date(l.last_login_at) : ''}</td>
        <td class="num">${edit ? html`
          <form method="post" action="/customers/${c.customer_id}/logins/${l.login_id}/link" class="inline"><button class="btn small">${l.password_hash ? 'Password reset link' : 'New invite link'}</button></form>
          <form method="post" action="/customers/${c.customer_id}/logins/${l.login_id}" class="inline">
            <input type="hidden" name="active" value="${l.active ? '0' : '1'}">
            <button class="btn small">${l.active ? 'Turn off' : 'Turn on'}</button></form>` : ''}</td></tr>
        ${edit && l.active ? html`<tr class="invite-row"><td colspan="4">${linkBox(l)}</td></tr>` : ''}</tbody></table>
      ${edit ? html`<details><summary>Change name or email</summary>
        <form method="post" action="/customers/${c.customer_id}/logins" class="form-grid">
          <label>Name<input name="full_name" required value="${l.full_name}"></label>
          <label>Email<input name="email" type="email" required value="${l.email}"></label>
          <div class="span2 actions"><button class="btn">Save login</button>
            <span class="muted small">The customer can also change these themselves under My account.</span></div>
        </form></details>` : ''}`)}
    ${edit && !logins.length ? html`<details open><summary>Add their login</summary>
      <form method="post" action="/customers/${c.customer_id}/logins" class="form-grid">
        <label>Name<input name="full_name" required value="${[c.first_name, c.last_name].filter(Boolean).join(' ')}"></label>
        <label>Email<input name="email" type="email" required value="${c.email || ''}"></label>
        <div class="span2 actions"><button class="btn primary">Add login</button>
          <span class="muted small">One login per customer. You'll get a link to send them so they can set their own password.</span></div>
      </form></details>` : ''}
  </section>`;
}

router.post('/:id(\\d+)/portal', need('portal'), async (req, res) => {
  const b = req.body;
  await query(`UPDATE customers SET portal_enabled = $2, portal_line_prices = $3, portal_totals = $4 WHERE customer_id = $1`,
    [req.params.id, b.enabled === '1', b.line_prices === '1', b.totals === '1']);
  res.redirect(`/customers/${req.params.id}#portal`);
});

router.post('/:id(\\d+)/logins', need('portal'), async (req, res) => {
  const name = String(req.body.full_name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const back = (err) => res.redirect(`/customers/${req.params.id}${err ? `?portal_error=${encodeURIComponent(err)}` : ''}#portal`);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return back('Enter a name and an email address.');
  try {
    // One login per customer: adding again changes its name and email.
    const { rows: [l] } = await query(`INSERT INTO customer_logins (customer_id, full_name, email, invite_token, invite_expires_at, created_by)
      VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), $6)
      ON CONFLICT (customer_id) DO UPDATE SET full_name = EXCLUDED.full_name, email = EXCLUDED.email
      RETURNING login_id, (xmax = 0) AS added`,
    [req.params.id, name, email, newToken(), INVITE_DAYS, userName()]);
    // Adding a login means they should be able to use it: turn the portal on.
    await query('UPDATE customers SET portal_enabled = true WHERE customer_id = $1', [req.params.id]);
    // A new login gets its invite by email right away (once email is set up).
    if (l.added && mail.configured() && await emailLink(req, req.params.id, l.login_id)) {
      return res.redirect(`/customers/${req.params.id}?emailed=${encodeURIComponent(email)}#portal`);
    }
  } catch (err) {
    if (err.code === '23505') return back('That email is already the login for another customer.');
    throw err;
  }
  back();
});

router.post('/:id(\\d+)/logins/:lid(\\d+)/link', need('portal'), async (req, res) => {
  await query(`UPDATE customer_logins SET invite_token = $3, invite_expires_at = now() + make_interval(days => $4)
    WHERE login_id = $2 AND customer_id = $1`, [req.params.id, req.params.lid, newToken(), INVITE_DAYS]);
  res.redirect(`/customers/${req.params.id}#portal`);
});

router.post('/:id(\\d+)/logins/:lid(\\d+)/email', need('portal'), async (req, res) => {
  const ok = await emailLink(req, req.params.id, req.params.lid);
  const { rows: [l] } = await query('SELECT email FROM customer_logins WHERE login_id = $1', [req.params.lid]);
  res.redirect(`/customers/${req.params.id}?${ok && l ? `emailed=${encodeURIComponent(l.email)}` : `portal_error=${encodeURIComponent('The email didn\'t go. Copy the link and send it yourself.')}`}#portal`);
});

router.post('/:id(\\d+)/logins/:lid(\\d+)', need('portal'), async (req, res) => {
  const active = req.body.active === '1';
  await query('UPDATE customer_logins SET active = $3 WHERE login_id = $2 AND customer_id = $1',
    [req.params.id, req.params.lid, active]);
  if (!active) await query('DELETE FROM customer_sessions WHERE login_id = $1', [req.params.lid]);
  res.redirect(`/customers/${req.params.id}#portal`);
});

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
      ${can('customers') ? html`<a class="btn primary" href="/customers/new">+ New customer</a>` : ''}
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

router.get('/new', need('customers'), (req, res) => {
  res.send(layout({
    title: 'New customer', active: '/customers',
    body: html`<h1>New customer</h1>${customerForm({}, { action: '/customers' })}`,
  }));
});

router.post('/', need('customers'), async (req, res) => {
  const c = fromBody(req.body);
  try {
    const { rows } = await query(`
      INSERT INTO customers (${FIELDS.join(', ')}, tax_exempt)
      VALUES (${FIELDS.map((_, i) => `$${i + 1}`).join(', ')}, $${FIELDS.length + 1})
      RETURNING customer_id`, [...FIELDS.map((f) => c[f]), c.tax_exempt]);
    qbo.customerChanged(rows[0].customer_id);
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
           t.grand_total
    FROM orders o JOIN v_order_totals t USING (order_id)
    WHERE o.customer_id = $1 ORDER BY o.ordered_on DESC, o.order_id DESC`, [c.customer_id]);
  const row = (label, v) => (v ? html`<dt>${label}</dt><dd>${v}</dd>` : '');
  const prices = can('prices');
  res.send(layout({
    title: c.display_name, active: '/customers',
    body: html`
    <div class="page-head">
      <h1>${c.display_name}</h1>
      <div>
        ${can('customers') ? html`<a class="btn" href="/customers/${c.customer_id}/edit">Edit</a>` : ''}
        ${can('quotes') ? html`<a class="btn primary" href="/orders/new?customer_id=${c.customer_id}">+ New quote</a>` : ''}
        ${isAdmin() && !orders.length ? deleteButton(`/customers/${c.customer_id}/delete`, `${c.display_name}${c.qbo_customer_id ? ' from the CRM (it stays in QuickBooks; make it inactive there too)' : ''}`) : ''}
      </div>
    </div>
    <div class="card"><dl class="details">
      ${row('Type', c.customer_type)}${row('Company', c.company_name)}
      ${row('Contact', [c.first_name, c.last_name].filter(Boolean).join(' '))}
      ${row('Phone', c.phone)}${row('Mobile', c.mobile)}${row('Email', c.email)}
      ${row('Terms', c.payment_terms)}${row('Usually', c.default_fulfillment === 'delivery' ? 'Gets delivery' : 'Picks up')}
      ${row('Tax', c.tax_exempt ? `Exempt${c.resale_cert_number ? ` (cert ${c.resale_cert_number})` : ''}` : 'Taxable')}
      ${row('Notes', c.notes)}
      ${await qboRow(c)}
    </dl></div>
    ${await portalCard(c, req)}
    <h2>Orders</h2>
    <table class="list">
      <thead><tr><th>Order #</th><th>Job</th><th>PO</th><th>Status</th><th>Date</th><th>Need by</th>${prices ? html`<th class="num">Total</th>` : ''}</tr></thead>
      <tbody>${orders.length ? orders.map((o) => html`
        <tr><td><a href="/orders/${o.order_id}">${o.order_number}</a></td><td>${o.job_name}</td><td>${o.po_number}</td>
        <td>${statusBadge(o.status)}</td><td>${date(o.ordered_on)}</td><td>${date(o.need_by)}</td>
        ${prices ? html`<td class="num">${money(o.grand_total)}</td>` : ''}</tr>`)
      : html`<tr><td colspan="7" class="empty">No orders yet.</td></tr>`}</tbody>
    </table>`,
  }));
});

// Only customers with no quotes or orders; anyone with history stays.
router.post('/:id(\\d+)/delete', need('admin'), async (req, res) => {
  if (!typedDelete(req.body)) return res.redirect(`/customers/${req.params.id}`);
  const { rowCount } = await query(`DELETE FROM customers WHERE customer_id = $1
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = $1)`, [req.params.id]);
  if (!rowCount) return res.status(400).send(layout({ title: 'Can\'t delete', active: '/customers',
    body: html`<h1>Can't delete this customer</h1><p>They have quotes or orders. Delete those first, or leave the customer as is.</p>
      <p><a class="btn" href="/customers/${req.params.id}">Back</a></p>` }));
  res.redirect('/customers');
});

router.get('/:id(\\d+)/edit', need('customers'), async (req, res) => {
  const { rows: [c] } = await query('SELECT * FROM customers WHERE customer_id = $1', [req.params.id]);
  if (!c) return res.status(404).send('Customer not found');
  res.send(layout({
    title: `Edit ${c.display_name}`, active: '/customers',
    body: html`<h1>Edit customer</h1>${customerForm(c, { action: `/customers/${c.customer_id}` })}`,
  }));
});

router.post('/:id(\\d+)', need('customers'), async (req, res) => {
  const c = fromBody(req.body);
  try {
    await query(`
      UPDATE customers SET ${FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')},
             tax_exempt = $${FIELDS.length + 1}
      WHERE customer_id = $${FIELDS.length + 2}`,
    [...FIELDS.map((f) => c[f]), c.tax_exempt, req.params.id]);
    qbo.customerChanged(Number(req.params.id));
    res.redirect(`/customers/${req.params.id}`);
  } catch (err) {
    res.status(400).send(layout({
      title: 'Edit customer', active: '/customers',
      body: html`<h1>Edit customer</h1>${customerForm(c, { action: `/customers/${req.params.id}`, error: friendlyError(err) })}`,
    }));
  }
});

module.exports = router;
