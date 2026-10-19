// Customer portal (/portal): customers sign in with their own login to see their
// quotes and orders, and approve or decline quotes. Approved quotes still need the
// shop's own approval (a Manager or Admin confirms them on the order page).
//
// Customer logins are separate from staff accounts: their own table, cookie and
// sessions, and every page here only ever loads the signed-in customer's orders.
// A Manager or Admin turns the portal on per customer and invites logins from the
// customer's page (src/routes/customers.js).
const crypto = require('crypto');
const { query } = require('../db');
const { hashPassword, checkPassword, passwordProblem } = require('../auth');
const { html, layout, money, date, STATUS_LABEL } = require('../html');
const { loadOrder, customerSheet } = require('./orders');
const { INVITE_DAYS, DECLINE_REASONS } = require('./portal-shared');
const mail = require('../mail');
const notices = require('../notices');

const router = require('../async-router')();

const COOKIE = 'hpcm_portal';
const SESSION_DAYS = 30;
const SHOP_PHONE = '(307) 331-6449';

// ---- sessions ------------------------------------------------------------------
const cookieValue = (req) => {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
};
function setCookie(req, res, value, maxAgeSec) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/portal', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
async function startSession(req, res, login) {
  const id = crypto.randomBytes(32).toString('base64url');
  await query(`INSERT INTO customer_sessions (session_id, login_id, expires_at)
    VALUES ($1, $2, now() + make_interval(days => $3))`, [id, login.login_id, SESSION_DAYS]);
  await query('UPDATE customer_logins SET last_login_at = now() WHERE login_id = $1', [login.login_id]);
  setCookie(req, res, id, SESSION_DAYS * 86400);
}

// The signed-in customer login, only while it's active and the customer's portal is on.
const LOGIN_COLS = `l.login_id, l.customer_id, l.full_name, l.email, l.phone, l.can_approve,
  c.display_name AS customer_name, c.portal_line_prices, c.portal_totals`;
async function loadLogin(req) {
  const id = cookieValue(req);
  if (!id) return null;
  const { rows: [l] } = await query(`
    UPDATE customer_sessions s SET last_seen_at = now(), expires_at = now() + make_interval(days => $2)
    FROM customer_logins l JOIN customers c USING (customer_id)
    WHERE s.session_id = $1 AND l.login_id = s.login_id AND s.expires_at > now()
      AND l.active AND c.portal_enabled AND c.active
    RETURNING ${LOGIN_COLS}`, [id, SESSION_DAYS]);
  return l || null;
}

const signedIn = async (req, res, next) => {
  try {
    req.login = await loadLogin(req);
    if (req.login) return next();
    if (req.method === 'GET') return res.redirect(`/portal/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.status(401).send('Your sign-in has expired. Sign in again.');
  } catch (err) { next(err); }
};

// Slow down password guessing: 8 wrong tries for an email locks it for 15 minutes.
const failures = new Map();
const LOCK_TRIES = 8;
const LOCK_MS = 15 * 60 * 1000;
const locked = (email) => {
  const f = failures.get(email);
  if (f && Date.now() - f.first > LOCK_MS) failures.delete(email);
  return (failures.get(email)?.count || 0) >= LOCK_TRIES;
};
const failed = (email) => {
  const f = failures.get(email) || { count: 0, first: Date.now() };
  f.count += 1;
  failures.set(email, f);
};

const safeNext = (n) => (typeof n === 'string' && /^\/portal(\/|$)/.test(n) ? n : '/portal');
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

// ---- page shell ------------------------------------------------------------------
function page(login, { title, body }) {
  return layout({
    title,
    bare: true,
    body: html`
    <header class="topbar portal-bar">
      <a class="brand" href="/portal"><img src="/logo.svg" alt="High Plains Custom Metal"></a>
      ${login ? html`<nav><a href="/portal">My quotes &amp; orders</a><a href="/portal/account">My account</a></nav>
      <div class="who"><span>${login.full_name} · ${login.customer_name}</span>
        <form method="post" action="/portal/logout" class="inline"><button class="linkish">Sign out</button></form></div>` : ''}
    </header>
    <div class="portal">${body}</div>
    <footer class="portal-foot muted small">High Plains Custom Metal · 805 E Fox Farm Rd Unit B, Cheyenne, WY 82007 ·
      <a href="tel:+13073316449">${SHOP_PHONE}</a></footer>`,
  });
}

// ---- sign in -----------------------------------------------------------------------
function loginPage({ next, email = '', error, notice }) {
  return page(null, {
    title: 'Customer sign in',
    body: html`
    <div class="login-box">
      <h1>Customer sign in</h1>
      ${notice ? html`<div class="notice">${notice}</div>` : ''}
      ${error ? html`<div class="alert">${error}</div>` : ''}
      <form method="post" action="/portal/login" class="stack">
        <input type="hidden" name="next" value="${next}">
        <label>Email<input name="email" type="email" value="${email}" required autocomplete="username" autocapitalize="none"></label>
        <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="btn primary">Sign in</button>
      </form>
      <p class="muted small">${mail.configured() ? html`<a href="/portal/forgot">Forgot your password?</a> ` : 'Forgot your password? '}
        Don't have a login yet? Call us at ${SHOP_PHONE} and we'll send you a link to set one.</p>
    </div>`,
  });
}

router.get('/portal/login', async (req, res) => {
  if (await loadLogin(req)) return res.redirect(safeNext(req.query.next));
  res.send(loginPage({ next: safeNext(req.query.next), notice: req.query.out ? 'You\'re signed out.' : null }));
});

router.post('/portal/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const next = safeNext(req.body.next);
  const again = (error) => res.status(401).send(loginPage({ next, email, error }));
  if (locked(email)) return again('Too many tries. Wait 15 minutes, or call us for a new link.');
  const { rows: [l] } = await query(`
    SELECT l.*, c.portal_enabled FROM customer_logins l JOIN customers c USING (customer_id)
    WHERE lower(l.email) = $1 AND l.active AND c.active`, [email]);
  if (!l || !l.password_hash || !(await checkPassword(req.body.password, l.password_hash))) {
    failed(email);
    return again('That email and password don\'t match.');
  }
  failures.delete(email);
  if (!l.portal_enabled) return again(`Your online account is turned off right now. Call us at ${SHOP_PHONE}.`);
  await startSession(req, res, l);
  res.redirect(next);
});

router.post('/portal/logout', async (req, res) => {
  const id = cookieValue(req);
  if (id) await query('DELETE FROM customer_sessions WHERE session_id = $1', [id]);
  setCookie(req, res, '', 0);
  res.redirect('/portal/login?out=1');
});

// ---- forgot password: email a link (only once email sending is set up) ------------
const forgotPage = (sent, email = '') => page(null, {
  title: 'Forgot password',
  body: html`<div class="login-box"><h1>Forgot your password?</h1>
    ${sent ? html`<div class="notice">If ${email} has a login with us, we've emailed it a link to set a new password.
      Check your inbox (and spam folder).</div><p><a href="/portal/login">Back to sign in</a></p>`
    : html`<p>Enter the email you sign in with and we'll email you a link to set a new password.</p>
    <form method="post" action="/portal/forgot" class="stack">
      <label>Email<input name="email" type="email" required autocomplete="username" autocapitalize="none"></label>
      <button class="btn primary">Email me a link</button></form>
    <p class="muted small">Or call us at ${SHOP_PHONE}.</p>`}</div>`,
});
router.get('/portal/forgot', (req, res) => res.send(forgotPage(false)));
router.post('/portal/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  // Same answer whether or not the email has a login, so this can't be used to find logins.
  if (mail.configured() && isEmail(email) && !locked(`forgot:${email}`)) {
    failed(`forgot:${email}`);
    const token = crypto.randomBytes(24).toString('base64url');
    const { rows: [l] } = await query(`
      UPDATE customer_logins l SET invite_token = $2, invite_expires_at = now() + make_interval(days => $3)
      FROM customers c WHERE c.customer_id = l.customer_id AND lower(l.email) = $1 AND l.active AND c.portal_enabled AND c.active
      RETURNING l.full_name, l.email`, [email, token, INVITE_DAYS]);
    if (l) await notices.passwordLink(l, `${req.protocol}://${req.get('host')}/portal/set-password/${token}`, { reset: true });
  }
  res.send(forgotPage(true, email));
});

// ---- invite / reset link: set your own password ---------------------------------
async function inviteLogin(token) {
  if (!token || token.length < 20) return null;
  const { rows: [l] } = await query(`
    SELECT l.*, c.display_name AS customer_name FROM customer_logins l JOIN customers c USING (customer_id)
    WHERE l.invite_token = $1 AND l.invite_expires_at > now() AND l.active AND c.portal_enabled AND c.active`, [token]);
  return l || null;
}

function setPasswordPage(l, token, error) {
  return page(null, {
    title: 'Set your password',
    body: html`
    <div class="login-box">
      <h1>Welcome${l.password_hash ? ' back' : ''}</h1>
      <p>Set a password for <strong>${l.email}</strong> to see ${l.customer_name}'s quotes and orders with High Plains Custom Metal.</p>
      ${error ? html`<div class="alert">${error}</div>` : ''}
      <form method="post" action="/portal/set-password/${token}" class="stack">
        <label>Your name<input name="full_name" value="${l.full_name}" required autocomplete="name"></label>
        <label>Password<input name="password" type="password" required autocomplete="new-password" minlength="8"></label>
        <label>Password again<input name="password2" type="password" required autocomplete="new-password"></label>
        <button class="btn primary">Save and sign in</button>
      </form>
    </div>`,
  });
}

const deadLink = () => page(null, {
  title: 'Link expired',
  body: html`<div class="login-box"><h1>This link doesn't work anymore</h1>
    <p>Links to set a password last ${INVITE_DAYS} days and work once. Call us at ${SHOP_PHONE} and we'll send a new one,
    or <a href="/portal/login">sign in</a> if you've already set your password.</p></div>`,
});

router.get('/portal/set-password/:token', async (req, res) => {
  const l = await inviteLogin(req.params.token);
  if (!l) return res.status(404).send(deadLink());
  res.send(setPasswordPage(l, req.params.token));
});

router.post('/portal/set-password/:token', async (req, res) => {
  const l = await inviteLogin(req.params.token);
  if (!l) return res.status(404).send(deadLink());
  const b = req.body;
  const name = String(b.full_name || '').trim();
  const problem = !name ? 'Enter your name.' : passwordProblem(b.password)
    || (b.password !== b.password2 ? 'The two passwords don\'t match.' : null);
  if (problem) return res.status(400).send(setPasswordPage({ ...l, full_name: name || l.full_name }, req.params.token, problem));
  await query(`UPDATE customer_logins SET full_name = $2, password_hash = $3, invite_token = NULL, invite_expires_at = NULL
    WHERE login_id = $1`, [l.login_id, name, await hashPassword(b.password)]);
  // A new password signs out anywhere else this login was signed in.
  await query('DELETE FROM customer_sessions WHERE login_id = $1', [l.login_id]);
  await startSession(req, res, l);
  res.redirect('/portal');
});

// ---- home: their quotes and orders ---------------------------------------------------
const VISIBLE = "o.customer_id = $1 AND NOT o.portal_hidden";

// Where an order is, as steps the customer can follow.
function steps(o) {
  if (o.status === 'cancelled') return html`<p class="muted">This ${o.ordered_on ? 'order' : 'quote'} was cancelled.</p>`;
  const s = o.status;
  const after = (list) => list.includes(s);
  const pickup = o.fulfillment === 'delivery' ? 'Delivered' : 'Picked up';
  const list = [
    ['Quoted', true],
    [o.customer_decision === 'approved' || s !== 'quote' ? 'You approved' : 'Your approval', o.customer_decision === 'approved' || s !== 'quote'],
    [after(['confirmed', 'in_production', 'ready', 'completed', 'invoiced']) ? 'We approved' : 'Our approval', after(['confirmed', 'in_production', 'ready', 'completed', 'invoiced'])],
    ['In production', after(['in_production', 'ready', 'completed', 'invoiced'])],
    [o.fulfillment === 'delivery' ? 'Ready to deliver' : 'Ready for pickup', after(['ready', 'completed', 'invoiced'])],
    [pickup, after(['completed', 'invoiced'])],
  ];
  const current = list.findIndex(([, done]) => !done);
  return html`<ol class="steps">${list.map(([label, done], i) => html`
    <li class="${done ? 'done' : i === current ? 'current' : ''}">${label}</li>`)}</ol>`;
}

const customerStatus = (o) => {
  if (o.status === 'quote') {
    if (o.customer_decision === 'approved') return 'Approved by you, waiting on us';
    if (o.customer_decision === 'declined') return 'Declined';
    if (o.valid_until < today()) return 'Expired';
    return 'Waiting on your answer';
  }
  if (o.status === 'invoiced') return 'Completed';
  if (o.status === 'confirmed') return 'Approved';
  if (o.status === 'ready') return o.fulfillment === 'delivery' ? 'Ready to deliver' : 'Ready for pickup';
  return STATUS_LABEL[o.status];
};

router.get('/portal', signedIn, async (req, res) => {
  const l = req.login;
  const { rows } = await query(`
    SELECT o.order_id, o.order_number, o.job_name, o.po_number, o.status, o.need_by, o.ordered_on, o.fulfillment,
           o.customer_decision, t.grand_total,
           COALESCE(o.quote_expires_on, (o.created_at AT TIME ZONE 'America/Denver')::date + 30) AS valid_until,
           (o.created_at AT TIME ZONE 'America/Denver')::date AS quoted_on
    FROM orders o JOIN v_order_totals t USING (order_id)
    WHERE ${VISIBLE}
    ORDER BY o.order_id DESC`, [l.customer_id]);
  const groups = [
    ['Quotes waiting on your answer', rows.filter((o) => o.status === 'quote' && !o.customer_decision && o.valid_until >= today())],
    ['Approved by you, waiting on us', rows.filter((o) => o.status === 'quote' && o.customer_decision === 'approved')],
    ['In the works', rows.filter((o) => ['confirmed', 'in_production', 'ready'].includes(o.status))],
    ['Past orders', rows.filter((o) => ['completed', 'invoiced'].includes(o.status))],
    ['Closed quotes', rows.filter((o) => (o.status === 'quote' && (o.customer_decision === 'declined'
      || (!o.customer_decision && o.valid_until < today()))) || o.status === 'cancelled')],
  ];
  const table = (list) => html`<table class="list">
    <thead><tr><th>Number</th><th>Job</th><th>PO</th><th>Status</th><th>Date</th><th>Need by</th>
      ${l.portal_totals ? html`<th class="num">Total</th>` : ''}</tr></thead>
    <tbody>${list.map((o) => html`<tr>
      <td><a href="/portal/orders/${o.order_id}">${o.order_number}</a></td><td>${o.job_name}</td><td>${o.po_number}</td>
      <td><span class="badge badge-${o.status}">${customerStatus(o)}</span></td>
      <td>${date(o.ordered_on || o.quoted_on)}</td><td>${date(o.need_by)}</td>
      ${l.portal_totals ? html`<td class="num">${money(o.grand_total)}</td>` : ''}</tr>`)}</tbody></table>`;
  res.send(page(l, {
    title: 'My quotes & orders',
    body: html`
    <h1>${l.customer_name}</h1>
    ${rows.length ? '' : html`<p class="muted">Nothing here yet. Quotes we write for you will show up here.</p>`}
    ${groups.filter(([, list]) => list.length).map(([title, list]) => html`<h2>${title}</h2>${table(list)}`)}`,
  }));
});

// ---- one quote or order -----------------------------------------------------------------
async function customerOrder(l, id) {
  const { rows: [ok] } = await query(`SELECT 1 FROM orders o WHERE o.order_id = $2 AND ${VISIBLE}`, [l.customer_id, Number(id) || 0]);
  return ok ? loadOrder(Number(id)) : null;
}

router.get('/portal/orders/:id(\\d+)', signedIn, async (req, res) => {
  const l = req.login;
  const o = await customerOrder(l, req.params.id);
  if (!o) return res.status(404).send(page(l, { title: 'Not found', body: html`<h1>Not found</h1><p><a href="/portal">Back</a></p>` }));
  const isQuote = o.status === 'quote';
  const expired = isQuote && o.valid_until < today();
  const decided = o.customer_decision && html`<div class="${o.customer_decision === 'approved' ? 'notice' : 'alert'}">
    ${o.customer_decision === 'approved' ? 'Approved' : 'Declined'} by ${o.customer_decided_by}
    ${new Date(o.customer_decided_at).toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'medium', timeStyle: 'short' })}${
    o.customer_decline_reason ? ` (${DECLINE_REASONS[o.customer_decline_reason]})` : ''}${
    o.customer_decision_note ? html`<br><span class="muted">${o.customer_decision_note}</span>` : ''}
    ${o.customer_decision === 'approved' && isQuote ? html`<br>We'll confirm it and set it up in the shop.` : ''}</div>`;
  let answer = '';
  if (isQuote && !o.customer_decision) {
    if (expired) {
      answer = html`<div class="alert">This quote expired on ${date(o.valid_until)}. Call us at ${SHOP_PHONE} and we'll update it.</div>`;
    } else if (!l.can_approve) {
      answer = html`<p class="muted">Someone at ${l.customer_name} who can approve quotes needs to answer this one.</p>`;
    } else {
      answer = html`
      <div class="portal-answer no-print">
        <form method="post" action="/portal/orders/${o.order_id}/decision" class="card form-grid">
          <h2 class="span2">Approve this quote</h2>
          <label class="check span2 confirm-check"><input type="checkbox" name="checked" value="1" required>
            I checked the lengths, quantities and colors. Everything is cut exactly as listed.</label>
          <label>Need it by<input type="date" name="need_by" min="${today()}" value="${o.need_by || ''}"></label>
          <label>PO # (optional)<input name="po_number" value="${o.po_number || ''}"></label>
          <label class="span2">Note to us (optional)<textarea name="note" rows="2"></textarea></label>
          <div class="span2 actions"><button class="btn primary" name="decision" value="approved">Approve quote</button></div>
        </form>
        <details class="card"><summary>Decline or ask for changes</summary>
          <form method="post" action="/portal/orders/${o.order_id}/decision" class="form-grid">
            <label>Why<select name="reason" required><option value="">Pick one…</option>
              ${Object.entries(DECLINE_REASONS).map(([v, label]) => html`<option value="${v}">${label}</option>`)}</select></label>
            <label class="span2">What should we change? (optional)<textarea name="note" rows="2"></textarea></label>
            <div class="span2 actions"><button class="btn" name="decision" value="declined">Send</button></div>
          </form>
        </details>
      </div>`;
    }
  }
  res.send(page(l, {
    title: `${isQuote ? 'Quote' : 'Order'} ${o.order_number}`,
    body: html`
    <div class="page-head no-print">
      <h1>${isQuote ? 'Quote' : 'Order'} ${o.order_number}</h1>
      <div class="actions"><a class="btn" href="/portal">Back</a>
        <button class="btn" onclick="window.print()">Print or save as PDF</button></div>
    </div>
    ${req.query.error ? html`<div class="alert no-print">${req.query.error}</div>` : ''}
    <div class="no-print">${steps(o)}</div>
    ${decided || ''}
    ${customerSheet(o, { linePrices: l.portal_line_prices, totals: l.portal_totals })}
    ${answer}`,
  }));
});

router.post('/portal/orders/:id(\\d+)/decision', signedIn, async (req, res) => {
  const l = req.login;
  const id = Number(req.params.id);
  const back = (error) => res.redirect(`/portal/orders/${id}${error ? `?error=${encodeURIComponent(error)}` : ''}`);
  if (!l.can_approve) return back('Your login can\'t approve or decline quotes.');
  const b = req.body;
  const decision = b.decision === 'approved' ? 'approved' : b.decision === 'declined' ? 'declined' : null;
  if (!decision) return back('Pick approve or decline.');
  if (decision === 'approved' && b.checked !== '1') return back('Tick the box to say you checked the lengths, quantities and colors.');
  const reason = decision === 'declined' ? (DECLINE_REASONS[b.reason] ? b.reason : null) : null;
  if (decision === 'declined' && !reason) return back('Pick why you\'re declining.');
  const needBy = /^\d{4}-\d{2}-\d{2}$/.test(b.need_by || '') && b.need_by >= today() ? b.need_by : null;
  const note = String(b.note || '').trim().slice(0, 2000) || null;
  const po = String(b.po_number || '').trim().slice(0, 100) || null;
  const { rowCount } = await query(`
    UPDATE orders o SET customer_decision = $3, customer_decided_at = now(), customer_decided_by = $4,
           customer_decision_note = $5, customer_decline_reason = $6,
           need_by = CASE WHEN $3 = 'approved' THEN COALESCE($7::date, need_by) ELSE need_by END,
           po_number = CASE WHEN $3 = 'approved' THEN COALESCE($8, po_number) ELSE po_number END
    WHERE o.order_id = $2 AND ${VISIBLE} AND o.status = 'quote' AND o.customer_decision IS NULL
      AND COALESCE(o.quote_expires_on, (o.created_at AT TIME ZONE 'America/Denver')::date + 30) >= (now() AT TIME ZONE 'America/Denver')::date`,
  [l.customer_id, id, decision, `${l.full_name} (${l.email})`, note, reason, needBy, po]);
  if (!rowCount) return back('This quote can\'t be answered anymore. Call us if something needs to change.');
  notices.quoteAnswered(id);
  back();
});

// ---- my account ---------------------------------------------------------------------
router.get('/portal/account', signedIn, async (req, res) => {
  const l = req.login;
  res.send(page(l, {
    title: 'My account',
    body: html`
    <h1>My account</h1>
    ${req.query.saved ? html`<div class="notice">Saved.</div>` : ''}
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    <form method="post" action="/portal/account" class="card form-grid" style="max-width:560px">
      <label class="span2">Your name<input name="full_name" value="${l.full_name}" required autocomplete="name"></label>
      <label>Email (you sign in with this)<input name="email" type="email" value="${l.email}" required autocomplete="username"></label>
      <label>Phone<input name="phone" type="tel" value="${l.phone || ''}" autocomplete="tel"></label>
      <label class="span2">New password <span class="muted small">(leave blank to keep it)</span>
        <input name="password" type="password" autocomplete="new-password"></label>
      <label class="span2">Current password <span class="muted small">(needed to save changes)</span>
        <input name="current" type="password" required autocomplete="current-password"></label>
      <div class="span2 actions"><button class="btn primary">Save</button></div>
    </form>
    <p class="muted small">Need help with your login? Call us at ${SHOP_PHONE}.</p>`,
  }));
});

router.post('/portal/account', signedIn, async (req, res) => {
  const l = req.login;
  const b = req.body;
  const back = (error) => res.redirect(`/portal/account?${error ? `error=${encodeURIComponent(error)}` : 'saved=1'}`);
  const { rows: [cur] } = await query('SELECT password_hash FROM customer_logins WHERE login_id = $1', [l.login_id]);
  if (!(await checkPassword(b.current, cur.password_hash))) return back('Your current password isn\'t right.');
  const name = String(b.full_name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  if (!name || !isEmail(email)) return back('Enter your name and email address.');
  if (b.password) {
    const problem = passwordProblem(b.password);
    if (problem) return back(problem);
  }
  try {
    await query(`UPDATE customer_logins SET full_name = $2, email = $3, phone = $4,
      password_hash = COALESCE($5, password_hash) WHERE login_id = $1`,
    [l.login_id, name, email, String(b.phone || '').trim() || null, b.password ? await hashPassword(b.password) : null]);
  } catch (err) {
    if (err.code === '23505') return back('Another login already uses that email.');
    throw err;
  }
  if (b.password) {
    await query('DELETE FROM customer_sessions WHERE login_id = $1 AND session_id <> $2', [l.login_id, cookieValue(req)]);
  }
  back();
});

router.use('/portal', (req, res) => res.status(404).send('Page not found'));

module.exports = router;
