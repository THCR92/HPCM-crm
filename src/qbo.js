// QuickBooks Online, both ways.
//
//   CRM -> QuickBooks
//     * customers, whenever one is added or edited here
//     * orders, as invoices, when they're completed (picked up or delivered)
//   QuickBooks -> CRM
//     * customers added or edited in QuickBooks: QuickBooks calls /qbo/webhook,
//       and every few minutes the CRM asks for anything changed since its last
//       check (catches webhooks that never arrived)
//
// Setup (Render > Environment): QBO_CLIENT_ID and QBO_CLIENT_SECRET from the
// Intuit developer app, QBO_ENVIRONMENT = sandbox (test company, the default) or
// production (the real books), and optionally QBO_WEBHOOK_TOKEN (the webhook
// "verifier token"). An Admin then presses Connect on Admin > QuickBooks.
//
// All QuickBooks work runs one job at a time (later()) so token refreshes and
// SyncTokens never race, and a slow or failing QuickBooks never holds up a page.
const crypto = require('crypto');
const { query } = require('./db');

const OAUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const API_BASE = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
};
const MINOR_VERSION = 75;
const SCOPE = 'com.intuit.quickbooks.accounting';
const CHECK_EVERY_MS = 10 * 60 * 1000;

// Swapped out by the tests for a pretend QuickBooks.
const io = { fetch: (...args) => globalThis.fetch(...args) };

const config = () => ({
  clientId: process.env.QBO_CLIENT_ID || '',
  clientSecret: process.env.QBO_CLIENT_SECRET || '',
  environment: process.env.QBO_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
  webhookToken: process.env.QBO_WEBHOOK_TOKEN || '',
});
const configured = () => Boolean(config().clientId && config().clientSecret);

// The address QuickBooks sends people back to. It must match a Redirect URI on
// the Intuit app exactly, so on Render it's always the www address.
function redirectUri(req) {
  if (process.env.QBO_REDIRECT_URI) return process.env.QBO_REDIRECT_URI;
  if (process.env.RENDER) return 'https://www.hpcmcrm.net/qbo/callback';
  return `${req.protocol}://${req.get('host')}/qbo/callback`;
}

class QboError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// ---- tokens (encrypted at rest with a key made from the client secret) ---------
const key = () => crypto.createHash('sha256').update(`hpcm-qbo:${config().clientSecret}`).digest();
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
function unseal(sealed) {
  const [iv, tag, data] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

async function connection() {
  const { rows: [c] } = await query('SELECT * FROM qbo_connection WHERE id = 1');
  return c || null;
}

async function tokenRequest(params) {
  const { clientId, clientSecret } = config();
  const res = await io.fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new QboError(body.error_description || body.error || `QuickBooks sign-in answered ${res.status}`, res.status, body);
  return body;
}

const expiry = (seconds) => new Date(Date.now() + Number(seconds || 3600) * 1000);

async function saveTokens(t) {
  await query(`UPDATE qbo_connection SET access_token = $1, access_expires_at = $2,
      refresh_token = $3, refresh_expires_at = $4, last_error = NULL WHERE id = 1`,
  [seal(t.access_token), expiry(t.expires_in), seal(t.refresh_token), expiry(t.x_refresh_token_expires_in || 8640000)]);
}

// A current access token, refreshed when it's about to run out (they last an hour).
async function accessToken(conn, force = false) {
  if (!force && new Date(conn.access_expires_at) - Date.now() > 60 * 1000) return unseal(conn.access_token);
  let t;
  try {
    t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: unseal(conn.refresh_token) });
  } catch (err) {
    if (err.body && err.body.error === 'invalid_grant') {
      await query("UPDATE qbo_connection SET last_error = 'QuickBooks needs to be connected again (the sign-in expired or was removed). An Admin can press Connect on Admin > QuickBooks.' WHERE id = 1");
    }
    throw err;
  }
  await saveTokens(t);
  return t.access_token;
}

// ---- API calls -----------------------------------------------------------------
const faultMessage = (body) => {
  const e = body && body.Fault && body.Fault.Error && body.Fault.Error[0];
  return e ? [e.Message, e.Detail].filter(Boolean).join(': ') : null;
};

// log = { entity, table, id, op } records the call in qbo_sync_log.
async function api(method, path, body, log) {
  const conn = await connection();
  if (!conn) throw new QboError('QuickBooks is not connected.');
  const requestId = crypto.randomUUID();
  let url = `${API_BASE[conn.environment]}/v3/company/${conn.realm_id}/${path}`;
  url += `${url.includes('?') ? '&' : '?'}minorversion=${MINOR_VERSION}`;
  if (method === 'POST') url += `&requestid=${requestId}`;
  let res;
  let json;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await accessToken(attempt ? await connection() : conn, attempt > 0);
    res = await io.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try { json = text ? JSON.parse(text) : {}; } catch { json = { text }; }
    if (res.status !== 401) break;
  }
  const error = res.ok && !json.Fault ? null : faultMessage(json) || `QuickBooks answered ${res.status}`;
  if (log) {
    const saved = json && json[log.entity];
    await query(`INSERT INTO qbo_sync_log (entity, local_table, local_id, operation, request_id, request_body,
        response_status, response_body, qbo_id, succeeded, error)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [log.entity, log.table, log.id ?? null, log.op, requestId, body || null, res.status, json,
      saved ? saved.Id : null, !error, error]);
  }
  if (error) throw new QboError(error, res.status, json);
  return json;
}

// QuickBooks' query language quotes text with single quotes, escaped by backslash.
const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
async function select(q) {
  const out = await api('GET', `query?query=${encodeURIComponent(q)}`);
  return out.QueryResponse || {};
}

// ---- one job at a time ------------------------------------------------------------
let chain = Promise.resolve();
function later(job) {
  const p = chain.then(job).catch((err) => console.error('QuickBooks:', err.message));
  chain = p;
  return p;
}
const idle = () => chain;
const connected = async () => configured() && Boolean(await connection());

// ---- customers: CRM <-> QuickBooks --------------------------------------------------
const cut = (v, n) => (v ? String(v).slice(0, n) : undefined);
const qbName = (s) => String(s).replace(/:/g, '-').trim();

async function customerAddresses(customerId) {
  const { rows } = await query(`SELECT DISTINCT ON (address_type) * FROM customer_addresses
    WHERE customer_id = $1 AND address_type IN ('billing', 'shipping')
    ORDER BY address_type, is_default DESC, address_id`, [customerId]);
  return Object.fromEntries(rows.map((a) => [a.address_type, a]));
}
const toQbAddr = (a) => a && {
  Line1: a.line1, Line2: a.line2 || undefined, City: a.city,
  CountrySubDivisionCode: a.state, PostalCode: a.postal_code, Country: a.country || 'US',
};

function customerBody(c, addr) {
  return {
    DisplayName: cut(qbName(c.display_name), 500),
    CompanyName: cut(c.company_name, 100) || '',
    GivenName: cut(c.first_name, 100) || '',
    FamilyName: cut(c.last_name, 100) || '',
    ...(c.email ? { PrimaryEmailAddr: { Address: cut(c.email, 100) } } : {}),
    ...(c.phone ? { PrimaryPhone: { FreeFormNumber: cut(c.phone, 30) } } : {}),
    ...(c.mobile ? { Mobile: { FreeFormNumber: cut(c.mobile, 30) } } : {}),
    Notes: cut(c.notes, 2000) || '',
    ResaleNum: cut(c.resale_cert_number, 15) || '',
    Taxable: !c.tax_exempt,
    Active: c.active,
    ...(addr.billing ? { BillAddr: toQbAddr(addr.billing) } : {}),
    ...(addr.shipping ? { ShipAddr: toQbAddr(addr.shipping) } : {}),
  };
}

// Sends one CRM customer to QuickBooks: updates the linked one, links to one
// with the same name, or creates it. Problems are saved on the customer.
async function pushCustomer(customerId) {
  const { rows: [c] } = await query('SELECT * FROM customers WHERE customer_id = $1', [customerId]);
  if (!c) return null;
  const log = { entity: 'Customer', table: 'customers', id: c.customer_id };
  try {
    const body = customerBody(c, await customerAddresses(c.customer_id));
    let existing = null;
    if (c.qbo_customer_id) {
      existing = (await api('GET', `customer/${c.qbo_customer_id}`).catch(() => null))?.Customer || null;
    }
    if (!existing) {
      existing = ((await select(`select * from Customer where DisplayName = ${quote(body.DisplayName)}`)).Customer || [])[0]
        // Inactive customers only show up when asked for by name and Active.
        || ((await select(`select * from Customer where DisplayName = ${quote(body.DisplayName)} and Active = false`)).Customer || [])[0]
        || null;
    }
    // Clear in QuickBooks what was cleared here, or the next sync would bring it back.
    if (existing) {
      if (!c.email && existing.PrimaryEmailAddr) body.PrimaryEmailAddr = { Address: '' };
      if (!c.phone && existing.PrimaryPhone) body.PrimaryPhone = { FreeFormNumber: '' };
      if (!c.mobile && existing.Mobile) body.Mobile = { FreeFormNumber: '' };
    }
    const out = existing
      ? await api('POST', 'customer', { ...body, Id: existing.Id, SyncToken: existing.SyncToken, sparse: true }, { ...log, op: 'update' })
      : await api('POST', 'customer', body, { ...log, op: 'create' });
    await query(`UPDATE customers SET qbo_customer_id = $1, qbo_sync_token = $2, qbo_synced_at = now(),
        qbo_last_error = NULL WHERE customer_id = $3`, [out.Customer.Id, out.Customer.SyncToken, c.customer_id]);
    return out.Customer.Id;
  } catch (err) {
    await query('UPDATE customers SET qbo_last_error = $1 WHERE customer_id = $2', [err.message, c.customer_id]);
    throw err;
  }
}

const phone = (p) => (p && p.FreeFormNumber) || null;
const blank = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

// Brings one QuickBooks customer into the CRM: updates the linked customer, links
// to one with the same name, or adds it. Sub-customers (QuickBooks "jobs") are
// left out; the CRM keeps jobs on the order instead.
async function pullCustomer(q) {
  if (q.Job || q.ParentRef) return null;
  const { rows: [linked] } = await query(`SELECT customer_id FROM customers WHERE qbo_customer_id = $1
    UNION ALL (SELECT customer_id FROM customers WHERE lower(display_name) = lower($2) AND qbo_customer_id IS NULL LIMIT 1)
    LIMIT 1`, [q.Id, q.DisplayName]);
  if (q.status === 'Deleted' || q.Active === false) {
    if (linked) await query('UPDATE customers SET active = false, qbo_synced_at = now() WHERE customer_id = $1', [linked.customer_id]);
    return linked ? linked.customer_id : null;
  }
  const v = {
    display_name: q.DisplayName,
    company_name: blank(q.CompanyName),
    first_name: blank(q.GivenName),
    last_name: blank(q.FamilyName),
    email: blank(q.PrimaryEmailAddr && q.PrimaryEmailAddr.Address),
    phone: blank(phone(q.PrimaryPhone)),
    mobile: blank(phone(q.Mobile)),
    notes: blank(q.Notes),
    resale_cert_number: blank(q.ResaleNum),
    tax_exempt: q.Taxable === false,
  };
  // Some QuickBooks companies leave Taxable out; then the CRM's setting stands.
  if (linked && typeof q.Taxable !== 'boolean') delete v.tax_exempt;
  const cols = Object.keys(v);
  let id;
  if (linked) {
    id = linked.customer_id;
    await query(`UPDATE customers SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')}, active = true,
        qbo_customer_id = $${cols.length + 1}, qbo_sync_token = $${cols.length + 2}, qbo_synced_at = now(), qbo_last_error = NULL
      WHERE customer_id = $${cols.length + 3}`, [...Object.values(v), q.Id, q.SyncToken, id]);
  } else {
    const { rows: [n] } = await query(`INSERT INTO customers (${cols.join(', ')}, qbo_customer_id, qbo_sync_token, qbo_synced_at)
      VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}, $${cols.length + 2}, now())
      RETURNING customer_id`, [...Object.values(v), q.Id, q.SyncToken]);
    id = n.customer_id;
  }
  await pullAddress(id, 'billing', q.BillAddr);
  await pullAddress(id, 'shipping', q.ShipAddr);
  return id;
}

// QuickBooks addresses become the customer's default billing or shipping address
// when they have enough to be one (street, city, two-letter state, zip).
async function pullAddress(customerId, type, a) {
  if (!a || !a.Line1 || !a.City || !/^[A-Za-z]{2}$/.test(a.CountrySubDivisionCode || '') || !a.PostalCode) return;
  const vals = [a.Line1, blank(a.Line2), a.City, a.CountrySubDivisionCode.toUpperCase(), a.PostalCode, blank(a.Country) || 'US'];
  const { rowCount } = await query(`UPDATE customer_addresses SET line1 = $3, line2 = $4, city = $5, state = $6,
      postal_code = $7, country = $8
    WHERE customer_id = $1 AND address_type = $2 AND is_default`, [customerId, type, ...vals]);
  if (!rowCount) {
    await query(`INSERT INTO customer_addresses (customer_id, address_type, line1, line2, city, state, postal_code, country, is_default)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`, [customerId, type, ...vals]);
  }
}

// One bad customer (say, a name another CRM customer already uses) doesn't stop
// the rest; it's written to the QuickBooks activity list instead.
async function pullSafely(q) {
  try {
    return await pullCustomer(q);
  } catch (err) {
    await query(`INSERT INTO qbo_sync_log (entity, local_table, operation, request_id, qbo_id, succeeded, error, response_body)
      VALUES ('Customer', 'customers', 'pull', gen_random_uuid(), $1, false, $2, $3)`,
    [q.Id, `${q.DisplayName}: ${err.code === '23505' ? 'another CRM customer already has that name' : err.message}`, q]);
    return null;
  }
}

// Fetches a customer QuickBooks told us about and brings it in.
async function pullCustomerById(qbId) {
  let q;
  try {
    q = (await api('GET', `customer/${encodeURIComponent(qbId)}`)).Customer;
  } catch (err) {
    if (err.status === 400 || err.status === 404) q = { Id: String(qbId), status: 'Deleted' };
    else throw err;
  }
  return pullSafely(q);
}

// Customers changed in QuickBooks since the last check (QuickBooks keeps 30 days).
async function checkCustomers() {
  const conn = await connection();
  if (!conn) return 0;
  const started = new Date();
  const since = conn.customers_checked_at && Date.now() - new Date(conn.customers_checked_at) < 29 * 86400000
    ? new Date(conn.customers_checked_at) : null;
  let changed = 0;
  if (!since) {
    changed = await importAllCustomers();
  } else {
    const out = await api('GET', `cdc?entities=Customer&changedSince=${encodeURIComponent(since.toISOString())}`);
    for (const r of out.CDCResponse || []) {
      for (const qr of r.QueryResponse || []) {
        for (const q of qr.Customer || []) { await pullSafely(q); changed += 1; }
      }
    }
  }
  await query('UPDATE qbo_connection SET customers_checked_at = $1 WHERE id = 1', [started]);
  return changed;
}

async function importAllCustomers() {
  let n = 0;
  for (let start = 1; ; start += 1000) {
    const page = (await select(`select * from Customer startposition ${start} maxresults 1000`)).Customer || [];
    for (const q of page) { await pullSafely(q); n += 1; }
    if (page.length < 1000) return n;
  }
}

// Both directions at once: everything from QuickBooks, then every CRM customer
// QuickBooks doesn't have yet. Run after connecting and from the Sync button.
async function syncAllCustomers() {
  const pulled = await checkCustomers().catch(async (err) => {
    await query('UPDATE qbo_connection SET last_error = $1 WHERE id = 1', [err.message]);
    throw err;
  });
  const { rows } = await query('SELECT customer_id FROM customers WHERE active AND qbo_customer_id IS NULL ORDER BY customer_id');
  let pushed = 0;
  for (const r of rows) {
    try { await pushCustomer(r.customer_id); pushed += 1; } catch { /* saved on the customer */ }
  }
  return { pulled, pushed };
}

// ---- items and invoices ------------------------------------------------------------------
async function incomeAccountId() {
  const conn = await connection();
  if (conn.income_account_id) return conn.income_account_id;
  const accounts = (await select("select * from Account where AccountType = 'Income' and Active = true")).Account || [];
  const pick = accounts.find((a) => /sales of product/i.test(a.Name)) || accounts.find((a) => /sales/i.test(a.Name)) || accounts[0];
  if (!pick) throw new QboError('QuickBooks has no income account to put sales in. Add one in QuickBooks (Chart of accounts).');
  await query('UPDATE qbo_connection SET income_account_id = $1 WHERE id = 1', [pick.Id]);
  return pick.Id;
}

const itemCache = new Map();
// The QuickBooks item for a name, made if QuickBooks doesn't have it.
async function itemFor(name, { type = 'NonInventory', taxable = true, productId = null, sku = null } = {}) {
  const n = cut(qbName(name), 100);
  if (itemCache.has(n)) return itemCache.get(n);
  let item = ((await select(`select * from Item where Name = ${quote(n)}`)).Item || [])[0];
  if (!item) {
    item = (await api('POST', 'item', {
      Name: n, Type: type, Taxable: taxable, Sku: cut(sku, 100),
      IncomeAccountRef: { value: await incomeAccountId() },
    }, { entity: 'Item', table: 'products', id: productId, op: 'create' })).Item;
  }
  itemCache.set(n, item.Id);
  return item.Id;
}

async function productItem(p) {
  if (p.qbo_item_id) return p.qbo_item_id;
  const id = await itemFor(p.qbo_item_name || p.product_name, {
    type: ['service', 'delivery'].includes(p.category) ? 'Service' : 'NonInventory',
    taxable: p.product_taxable, productId: p.product_id, sku: p.sku,
  });
  await query('UPDATE products SET qbo_item_id = $1 WHERE product_id = $2', [id, p.product_id]);
  return id;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const denverDate = (d) => new Date(d || Date.now()).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

async function invoiceBody(o) {
  const { rows: lines } = await query(`
    SELECT l.*, oi.line_discount, p.product_id, p.category, p.qbo_item_name, p.taxable AS product_taxable
    FROM v_order_invoice_lines l
    JOIN order_items oi USING (order_item_id)
    JOIN products p ON p.product_id = oi.product_id
    WHERE l.order_id = $1
    ORDER BY l.section_sort NULLS LAST, l.line_no`, [o.order_id]);
  const exempt = o.tax_exempt_effective;
  const taxCode = (taxable) => ({ value: taxable && !exempt ? 'TAX' : 'NON' });
  const Line = [];
  for (const l of lines) {
    Line.push({
      DetailType: 'SalesItemLineDetail',
      Description: cut(l.qbo_description, 4000),
      // Line discounts go on the discount line, so each line is exactly qty x price.
      Amount: round2(Number(l.qbo_qty) * Number(l.qbo_unit_price)),
      SalesItemLineDetail: {
        ItemRef: { value: await productItem(l) },
        Qty: Number(l.qbo_qty), UnitPrice: Number(l.qbo_unit_price), TaxCodeRef: taxCode(l.taxable),
      },
    });
  }
  if (Number(o.delivery_charge) > 0) {
    Line.push({
      DetailType: 'SalesItemLineDetail', Description: 'Delivery', Amount: round2(o.delivery_charge),
      SalesItemLineDetail: { ItemRef: { value: await itemFor('Delivery', { type: 'Service', taxable: false }) },
        Qty: 1, UnitPrice: round2(o.delivery_charge), TaxCodeRef: taxCode(false) },
    });
  }
  const discount = round2(Number(o.discount_amount) + lines.reduce((s, l) => s + Number(l.line_discount || 0), 0));
  if (discount > 0) Line.push({ DetailType: 'DiscountLineDetail', Amount: discount, DiscountLineDetail: { PercentBased: false } });
  const memo = [o.job_name && `Job: ${o.job_name}`, o.po_number && `PO: ${o.po_number}`, o.customer_memo].filter(Boolean).join('\n');
  const email = o.contact_email || o.customer_email;
  return {
    DocNumber: o.order_number,
    TxnDate: denverDate(o.completed_at),
    CustomerRef: { value: o.qbo_customer_id },
    Line,
    ...(memo ? { CustomerMemo: { value: cut(memo, 1000) } } : {}),
    PrivateNote: cut([`From the CRM, order ${o.order_number}`, o.internal_notes].filter(Boolean).join('\n'), 4000),
    ...(email ? { BillEmail: { Address: cut(email, 100) } } : {}),
    ...(Number(o.deposit_amount) > 0 ? { Deposit: round2(o.deposit_amount) } : {}),
    // The CRM's tax (5% on taxable materials) is what the customer was quoted.
    TxnTaxDetail: { TotalTax: round2(o.tax_amount) },
  };
}

const INVOICEABLE = ['completed', 'invoiced'];

// Sends a completed order to QuickBooks as an invoice (or updates the one it
// already has). With the real QuickBooks company the order then reads Invoiced
// and is locked; with the test company it stays Completed.
async function pushInvoice(orderId) {
  const { rows: [o] } = await query(`
    SELECT o.*, c.qbo_customer_id, c.email AS customer_email, t.tax_amount, t.tax_exempt AS tax_exempt_effective
    FROM orders o JOIN customers c USING (customer_id) JOIN v_order_totals t USING (order_id)
    WHERE o.order_id = $1`, [orderId]);
  if (!o || !INVOICEABLE.includes(o.status)) return null;
  const log = { entity: 'Invoice', table: 'orders', id: o.order_id };
  try {
    await query("UPDATE orders SET qbo_sync_status = 'pending' WHERE order_id = $1", [o.order_id]);
    o.qbo_customer_id = await pushCustomer(o.customer_id);
    const body = await invoiceBody(o);
    let existing = null;
    if (o.qbo_invoice_id) existing = (await api('GET', `invoice/${o.qbo_invoice_id}`).catch(() => null))?.Invoice || null;
    const out = existing
      ? await api('POST', 'invoice', { ...body, Id: existing.Id, SyncToken: existing.SyncToken, sparse: true }, { ...log, op: 'update' })
      : await api('POST', 'invoice', body, { ...log, op: 'create' });
    const conn = await connection();
    await query(`UPDATE orders SET qbo_invoice_id = $1, qbo_doc_number = $2, qbo_sync_token = $3,
        qbo_sync_status = 'synced', qbo_synced_at = now(), qbo_last_error = NULL,
        status = CASE WHEN $4 THEN 'invoiced'::order_status ELSE status END
      WHERE order_id = $5`,
    [out.Invoice.Id, out.Invoice.DocNumber || o.order_number, out.Invoice.SyncToken, conn.environment === 'production', o.order_id]);
    return out.Invoice.Id;
  } catch (err) {
    await query("UPDATE orders SET qbo_sync_status = 'error', qbo_last_error = $1 WHERE order_id = $2", [err.message, o.order_id]);
    throw err;
  }
}

// ---- what routes call ----------------------------------------------------------------
// Each checks for a connection first, so nothing happens until QuickBooks is set up.
const whenConnected = (job) => later(async () => { if (await connected()) return job(); return null; });
const customerChanged = (customerId) => whenConnected(() => pushCustomer(customerId));
const orderCompleted = (orderId) => whenConnected(() => pushInvoice(orderId));

// ---- connecting -----------------------------------------------------------------------
async function connectUrl(req, userId) {
  const state = crypto.randomBytes(24).toString('base64url');
  await query("DELETE FROM qbo_oauth_states WHERE created_at < now() - interval '1 day'");
  await query('INSERT INTO qbo_oauth_states (state, user_id) VALUES ($1, $2)', [state, userId]);
  const p = new URLSearchParams({
    client_id: config().clientId, response_type: 'code', scope: SCOPE, redirect_uri: redirectUri(req), state,
  });
  return `${OAUTH_URL}?${p}`;
}

// QuickBooks sent the person back with a code: trade it for tokens and save the
// connection. Connecting a different company forgets the old company's ids.
async function finishConnect(req, { code, state, realmId }, by) {
  const { rows: [s] } = await query(`DELETE FROM qbo_oauth_states WHERE state = $1
    AND created_at > now() - interval '30 minutes' RETURNING state`, [state || '']);
  if (!s) throw new QboError('That Connect link was old or already used. Press Connect again.');
  if (!code || !realmId) throw new QboError('QuickBooks didn\'t send back a company. Press Connect again.');
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(req) });
  const { rows: [prev] } = await query("SELECT value FROM app_settings WHERE key = 'qbo_realm_id'");
  if (prev && prev.value && prev.value !== String(realmId)) await forgetCompany();
  await query("UPDATE app_settings SET value = $1, updated_at = now() WHERE key = 'qbo_realm_id'", [String(realmId)]);
  await query(`INSERT INTO qbo_connection (id, environment, realm_id, access_token, access_expires_at,
      refresh_token, refresh_expires_at, connected_by)
    VALUES (1, $1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET environment = EXCLUDED.environment, realm_id = EXCLUDED.realm_id,
      access_token = EXCLUDED.access_token, access_expires_at = EXCLUDED.access_expires_at,
      refresh_token = EXCLUDED.refresh_token, refresh_expires_at = EXCLUDED.refresh_expires_at,
      connected_by = EXCLUDED.connected_by, connected_at = now(), last_error = NULL,
      income_account_id = CASE WHEN qbo_connection.realm_id = EXCLUDED.realm_id THEN qbo_connection.income_account_id END,
      customers_checked_at = CASE WHEN qbo_connection.realm_id = EXCLUDED.realm_id THEN qbo_connection.customers_checked_at END`,
  [config().environment, String(realmId), seal(t.access_token), expiry(t.expires_in), seal(t.refresh_token),
    expiry(t.x_refresh_token_expires_in || 8640000), by]);
  itemCache.clear();
  const info = await api('GET', `companyinfo/${encodeURIComponent(realmId)}`).catch(() => null);
  if (info && info.CompanyInfo) await query('UPDATE qbo_connection SET company_name = $1 WHERE id = 1', [info.CompanyInfo.CompanyName]);
  // The first customer sync runs on its own; the person doesn't wait for it.
  later(syncAllCustomers);
}

// Ids from another QuickBooks company mean nothing in this one. Orders already
// marked Invoiced keep their invoice number; the rest can be sent again.
async function forgetCompany() {
  await query('UPDATE customers SET qbo_customer_id = NULL, qbo_sync_token = NULL, qbo_synced_at = NULL, qbo_last_error = NULL');
  await query('UPDATE products SET qbo_item_id = NULL');
  await query(`UPDATE orders SET qbo_invoice_id = NULL, qbo_doc_number = NULL, qbo_sync_token = NULL,
      qbo_sync_status = 'not_synced', qbo_synced_at = NULL, qbo_last_error = NULL
    WHERE status <> 'invoiced'`);
  itemCache.clear();
}

async function disconnect() {
  const conn = await connection();
  if (!conn) return;
  try {
    const { clientId, clientSecret } = config();
    await io.fetch(REVOKE_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: unseal(conn.refresh_token) }),
    });
  } catch { /* forgetting the tokens here is what matters */ }
  await query('DELETE FROM qbo_connection WHERE id = 1');
}

// ---- webhooks ----------------------------------------------------------------------------
// QuickBooks signs each webhook with the verifier token. Only ids are taken from
// it; the customer itself is always fetched from QuickBooks.
function verifyWebhook(rawBody, signature) {
  const { webhookToken } = config();
  if (!webhookToken) return true;
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', webhookToken).update(rawBody).digest();
  const got = Buffer.from(String(signature), 'base64');
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// Customer ids in a webhook, in either of QuickBooks' formats (the older
// eventNotifications one, or the newer list of events).
function webhookCustomers(payload, realmId) {
  const ids = new Set();
  for (const n of (payload && payload.eventNotifications) || []) {
    if (String(n.realmId) !== String(realmId)) continue;
    for (const e of (n.dataChangeEvent && n.dataChangeEvent.entities) || []) {
      if (e.name === 'Customer' && e.id) ids.add(String(e.id));
    }
  }
  for (const e of Array.isArray(payload) ? payload : []) {
    if (String(e.intuitaccountid) !== String(realmId)) continue;
    if (/^qbo\.customer\./i.test(e.type || '') && e.intuitentityid) ids.add(String(e.intuitentityid));
  }
  return [...ids];
}

async function handleWebhook(rawBody, signature) {
  if (!verifyWebhook(rawBody, signature)) return false;
  const conn = await connection();
  if (!conn) return true;
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return true; }
  for (const id of webhookCustomers(payload, conn.realm_id)) later(() => pullCustomerById(id));
  return true;
}

// The catch-up check, every few minutes while the app runs. It also keeps the
// QuickBooks sign-in fresh (it lapses after 100 days without use).
function startChecks() {
  const tick = () => whenConnected(checkCustomers).catch(() => {});
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, CHECK_EVERY_MS).unref();
}

module.exports = {
  io, config, configured, redirectUri, connection, connected, later, idle,
  customerChanged, orderCompleted, pushCustomer, pushInvoice, pullCustomer, pullCustomerById,
  checkCustomers, syncAllCustomers, connectUrl, finishConnect, disconnect, handleWebhook, startChecks,
  QboError, API_BASE,
};
