// Admin > QuickBooks: connect, disconnect, sync customers, see what was sent.
// Plus the "Send to QuickBooks" buttons on customers and orders.
const { query } = require('../db');
const { html, layout } = require('../html');
const { need, userName } = require('../auth');
const qbo = require('../qbo');

const router = require('../async-router')();

const when = (d) => (d ? new Date(d).toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'medium', timeStyle: 'short' }) : '');
const ENV_LABEL = { sandbox: 'test company (sandbox)', production: 'your real QuickBooks company' };
const back = (res, msg, kind = 'msg') => res.redirect(`/admin/quickbooks?${kind}=${encodeURIComponent(msg)}`);

// What the CRM is sending Intuit, to compare with the Intuit app's Development keys.
// The Client ID isn't secret (it shows in the address bar on Intuit's page); the secret is never shown.
function keyCheck(cfg, req) {
  const id = cfg.clientId;
  return html`<details class="small"><summary>If Intuit says "undefined didn't connect"</summary>
    <p>Intuit doesn't recognize the Client ID. Compare these with <strong>Keys &amp; Credentials → Development</strong> on the Intuit app:</p>
    <ul>
      <li>Client ID in Render: starts <code>${id.slice(0, 6)}</code>, ends <code>${id.slice(-4)}</code>, ${id.length} characters
        (Intuit's are usually about 50).</li>
      <li>Client Secret in Render: ${cfg.clientSecret.length} characters (usually 40).</li>
      <li>Redirect URI on the Intuit app's Development tab must be exactly <code>${qbo.redirectUri(req)}</code></li>
      <li>Use the Development keys, not Production.</li>
    </ul></details>`;
}

// Customers that came in from QuickBooks and have no orders: with the test
// company, these are its made-up sample customers (and any added there while testing).
const TEST_CUSTOMERS = `
  SELECT c.customer_id, c.display_name, c.created_at FROM customers c
  WHERE c.created_from_qbo AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id)
  ORDER BY lower(c.display_name)`;

async function goLive() {
  const { rows } = await query(TEST_CUSTOMERS);
  return html`
  <div class="card">
    <h2>Switching to your real QuickBooks</h2>
    <ol>
      <li>${rows.length ? html`Remove the test company's customers below.` : 'Test customers: none left to remove.'}</li>
      <li>On the Intuit app, get the <strong>Production</strong> keys (Keys &amp; Credentials, Production switch on). Intuit asks for app
        details first. Use these addresses:
        <ul>
          <li>Host domain: <code>www.hpcmcrm.net</code></li>
          <li>Launch URL and Connect/Reconnect URL: <code>https://www.hpcmcrm.net/admin/quickbooks</code></li>
          <li>Disconnect URL: <code>https://www.hpcmcrm.net/admin/quickbooks</code></li>
          <li>End-user license agreement: <code>https://www.hpcmcrm.net/legal/terms</code></li>
          <li>Privacy policy: <code>https://www.hpcmcrm.net/legal/privacy</code></li>
          <li>Redirect URI on the <strong>Production</strong> tab: <code>https://www.hpcmcrm.net/qbo/callback</code></li>
        </ul></li>
      <li>In Render, replace <code>QBO_CLIENT_ID</code> and <code>QBO_CLIENT_SECRET</code> with the Production keys, and add
        <code>QBO_ENVIRONMENT</code> = <code>production</code>.</li>
      <li>Come back here and press <strong>Connect to QuickBooks</strong>, then pick your real company.</li>
    </ol>
    ${rows.length ? html`
    <form method="post" action="/qbo/test-customers/remove"
      onsubmit="return confirm('Delete the ticked customers from the CRM? They stay in the QuickBooks test company.')">
      <h3>Test customers to remove (${rows.length})</h3>
      <p class="muted small">These came in from the QuickBooks test company and have no quotes or orders. Untick any that are real.</p>
      <div class="check-list">${rows.map((r) => html`<label class="check"><input type="checkbox" name="id" value="${r.customer_id}" checked>
        <a href="/customers/${r.customer_id}">${r.display_name}</a></label>`)}</div>
      <button class="btn">Delete ticked customers</button>
    </form>` : ''}
  </div>`;
}

router.post('/qbo/test-customers/remove', need('admin'), async (req, res) => {
  const conn = await qbo.connection();
  if (!conn || conn.environment !== 'sandbox') return back(res, 'Test customers can only be removed while the test company is connected.', 'error');
  const ids = [].concat(req.body.id || []).map(Number).filter(Number.isInteger);
  const { rowCount } = await query(`DELETE FROM customers WHERE customer_id = ANY($1::int[])
    AND customer_id IN (SELECT customer_id FROM (${TEST_CUSTOMERS}) t)`, [ids]);
  back(res, `Removed ${rowCount} test customer${rowCount === 1 ? '' : 's'} from the CRM.`);
});

router.get('/admin/quickbooks', need('admin'), async (req, res) => {
  const cfg = qbo.config();
  const conn = await qbo.connection();
  const { rows: log } = await query(`
    SELECT l.*, c.display_name, o.order_number, p.name AS product_name
    FROM qbo_sync_log l
    LEFT JOIN customers c ON l.local_table = 'customers' AND c.customer_id = l.local_id
    LEFT JOIN orders o ON l.local_table = 'orders' AND o.order_id = l.local_id
    LEFT JOIN products p ON l.local_table = 'products' AND p.product_id = l.local_id
    ORDER BY l.sync_id DESC LIMIT 25`);
  const { rows: [counts] } = await query(`SELECT
      count(*) FILTER (WHERE active AND qbo_customer_id IS NOT NULL)::int AS linked,
      count(*) FILTER (WHERE active AND qbo_customer_id IS NULL)::int AS unlinked,
      count(*) FILTER (WHERE active AND qbo_last_error IS NOT NULL)::int AS errors
    FROM customers`);
  const { rows: [orders] } = await query(`SELECT
      count(*) FILTER (WHERE qbo_invoice_id IS NOT NULL)::int AS sent,
      count(*) FILTER (WHERE qbo_sync_status = 'error')::int AS errors
    FROM orders`);
  const what = (l) => {
    if (l.local_table === 'customers' && l.local_id) return html`<a href="/customers/${l.local_id}">${l.display_name || `Customer ${l.local_id}`}</a>`;
    if (l.local_table === 'orders' && l.local_id) return html`<a href="/orders/${l.local_id}">${l.order_number || `Order ${l.local_id}`}</a>`;
    if (l.local_table === 'products' && l.local_id) return html`${l.product_name || 'Item'}`;
    return l.entity;
  };
  const OPS = { create: 'Added to QuickBooks', update: 'Updated in QuickBooks', pull: 'Brought in from QuickBooks', read: 'Read from QuickBooks' };

  let status;
  if (!qbo.configured()) {
    status = html`
    <div class="card">
      <h2>Not set up yet</h2>
      <p>The Intuit app's keys aren't in Render yet. In Render, open the hpcm-crm service, go to
        <strong>Environment</strong>, and add <code>QBO_CLIENT_ID</code> and <code>QBO_CLIENT_SECRET</code>.</p>
      <p>On the Intuit app, the Redirect URI must be <code>${qbo.redirectUri(req)}</code></p>
    </div>`;
  } else if (!conn) {
    status = html`
    <div class="card">
      <h2>Not connected</h2>
      <p>Connecting signs in to QuickBooks once. You'll pick the company there; these keys are for the
        <strong>${ENV_LABEL[cfg.environment]}</strong>.</p>
      <form method="post" action="/qbo/connect"><button class="btn primary big-btn">Connect to QuickBooks</button></form>
      ${keyCheck(cfg, req)}
    </div>`;
  } else {
    status = html`
    <div class="card">
      <h2>Connected to ${conn.company_name || 'QuickBooks'}</h2>
      <p>${conn.environment === 'production' ? 'This is your real QuickBooks company.'
        : 'This is the QuickBooks test company: nothing here touches your real books, and orders stay Completed instead of Invoiced.'}</p>
      <dl class="details">
        <dt>Connected</dt><dd>${when(conn.connected_at)}${conn.connected_by ? ` by ${conn.connected_by}` : ''}</dd>
        <dt>Last check for QuickBooks changes</dt><dd>${when(conn.customers_checked_at) || 'Not yet'}</dd>
        <dt>Customers</dt><dd>${counts.linked} matched with QuickBooks${counts.unlinked ? `, ${counts.unlinked} not yet` : ''}${
          counts.errors ? `, ${counts.errors} with a problem` : ''}</dd>
        <dt>Invoices sent</dt><dd>${orders.sent}${orders.errors ? ` (${orders.errors} with a problem)` : ''}</dd>
        <dt>Webhook address</dt><dd><code>https://www.hpcmcrm.net/qbo/webhook</code>${cfg.webhookToken ? ' (verifier token set)' : ''}</dd>
      </dl>
      ${conn.last_error ? html`<div class="alert">${conn.last_error}</div>` : ''}
      <div class="actions">
        <form method="post" action="/qbo/sync" class="inline"><button class="btn primary">Sync customers now</button></form>
        <form method="post" action="/qbo/connect" class="inline"><button class="btn">Connect again</button></form>
        <form method="post" action="/qbo/disconnect" class="inline"
          onsubmit="return confirm('Disconnect QuickBooks? Nothing is deleted in either place.')"><button class="btn">Disconnect</button></form>
      </div>
    </div>`;
  }

  res.send(layout({
    title: 'QuickBooks', active: '/admin',
    body: html`
    <h1>QuickBooks</h1>
    ${req.query.msg ? html`<div class="notice">${req.query.msg}</div>` : ''}
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    ${status}
    ${conn && conn.environment === 'sandbox' ? await goLive() : ''}
    <div class="card">
      <h2>What goes where</h2>
      <ul>
        <li>Customers added or changed here are added or updated in QuickBooks right away.</li>
        <li>Customers added or changed in QuickBooks show up here within a few minutes. QuickBooks sub-customers (jobs) stay in QuickBooks.</li>
        <li>An order becomes a QuickBooks invoice when it's completed (picked up or delivered), with the same number (HP-…).
          Each line keeps its quantity, length and price; delivery, discount and deposit come along, and so does the CRM's sales tax.</li>
        <li>Estimates written in QuickBooks show up here as quotes within a few minutes. Items the CRM sells by the piece come in as
          that item; anything else comes in as "Item from QuickBooks" with its name and price, so the total matches. Once someone
          changes the quote here, later changes to the estimate in QuickBooks are left alone. Invoicing the order closes the estimate.</li>
        <li>Price list items are added to QuickBooks as products the first time they're invoiced.</li>
      </ul>
    </div>
    <h2>Recent activity</h2>
    <table class="list">
      <thead><tr><th>When</th><th>What</th><th>Done</th><th>Result</th></tr></thead>
      <tbody>${log.length ? log.map((l) => html`<tr>
        <td>${when(l.created_at)}</td><td>${what(l)}</td><td>${OPS[l.operation] || l.operation}</td>
        <td>${l.succeeded ? 'OK' : html`<span class="warn-text">${l.error || 'Failed'}</span>${l.intuit_tid ? html` <span class="muted small">(Intuit ref ${l.intuit_tid})</span>` : ''}`}</td></tr>`)
      : html`<tr><td colspan="4" class="empty">Nothing sent yet.</td></tr>`}</tbody>
    </table>`,
  }));
});

router.post('/qbo/connect', need('admin'), async (req, res) => {
  if (!qbo.configured()) return back(res, 'Add the Intuit keys in Render first.', 'error');
  res.redirect(await qbo.connectUrl(req, req.user.user_id));
});

router.get('/qbo/callback', need('admin'), async (req, res) => {
  if (req.query.error) {
    return back(res, req.query.error === 'access_denied' ? 'QuickBooks wasn\'t connected (you pressed Cancel).'
      : `QuickBooks said: ${req.query.error_description || req.query.error}`, 'error');
  }
  try {
    await qbo.finishConnect(req, { code: req.query.code, state: req.query.state, realmId: req.query.realmId }, userName());
  } catch (err) {
    return back(res, err.message, 'error');
  }
  back(res, 'Connected. Customers are being matched up both ways; refresh in a minute to see them.');
});

router.post('/qbo/disconnect', need('admin'), async (req, res) => {
  await qbo.disconnect();
  back(res, 'QuickBooks is disconnected. Nothing was deleted in either place.');
});

router.post('/qbo/sync', need('admin'), async (req, res) => {
  if (!(await qbo.connected())) return back(res, 'QuickBooks isn\'t connected.', 'error');
  qbo.later(qbo.syncAllCustomers);
  back(res, 'Syncing customers both ways. Refresh in a minute to see the results below.');
});

// Retry buttons on a customer or an order with a problem (or sent before connecting).
router.post('/customers/:id(\\d+)/qbo', need('customers'), async (req, res) => {
  await qbo.customerChanged(Number(req.params.id));
  res.redirect(`/customers/${req.params.id}`);
});

router.post('/orders/:id(\\d+)/qbo', need('approve', 'status'), async (req, res) => {
  await qbo.orderCompleted(Number(req.params.id));
  res.redirect(`/orders/${req.params.id}`);
});

module.exports = router;
