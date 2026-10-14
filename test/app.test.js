// Integration tests. Need a database loaded with `npm run db:setup` (DATABASE_URL).
const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/server');
const { query, pool } = require('../src/db');

let base;
let server;
// Every page needs a sign-in: tests run as an Admin unless they pass their own cookie.
const realFetch = global.fetch;
const sessions = {};
async function signIn(role, permissions) {
  const { ROLE_DEFAULTS } = require('../src/auth');
  const { rows: [u] } = await query(`INSERT INTO users (email, full_name, role, permissions, password_hash)
    VALUES ('test-' || gen_random_uuid() || '@example.com', 'Test ' || $1, $1, $2, 'x') RETURNING user_id`,
  [role, permissions || ROLE_DEFAULTS[role]]);
  const sid = `test-${u.user_id}-${Date.now()}`;
  await query("INSERT INTO user_sessions (session_id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')", [sid, u.user_id]);
  return `hpcm_session=${sid}`;
}
test.before(async () => {
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  sessions.admin = await signIn('admin');
  global.fetch = (url, opts = {}) => {
    const headers = new Headers(opts.headers || {});
    if (String(url).startsWith(base) && !headers.has('cookie') && !opts.anonymous) headers.set('cookie', sessions.admin);
    return realFetch(url, { ...opts, headers });
  };
});
test.after(async () => {
  global.fetch = realFetch;
  server.close();
  await pool.end();
});

const post = (path, body) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const productId = async (sku) => (await query('SELECT product_id FROM products WHERE sku = $1', [sku])).rows[0].product_id;

test('main pages load', async () => {
  for (const p of ['/orders', '/orders?tab=all', '/orders/new', '/customers', '/customers/new', '/products', '/colors']) {
    const res = await fetch(base + p);
    assert.strictEqual(res.status, 200, p);
  }
});

test('order totals are computed per pricing unit and lines keep their ids on edit', async () => {
  const { rows: [c] } = await query(
    "INSERT INTO customers (display_name) VALUES ('Test ' || gen_random_uuid()) RETURNING customer_id");
  const snap = await productId('PNL-SL-26');
  const pbr = await productId('PNL-PBR-26');
  const trim = await productId('TRM-CUST-26');
  const order = {
    customer_id: c.customer_id, job_name: 'Test job', delivery_charge: 50,
    sections: [
      { area: 'roof', items: [{ product_id: snap, pieces: 10, length_in: 120, width_in: 18, unit_price: 3.65 }] },
      { area: 'wall', items: [{ product_id: pbr, pieces: 4, length_in: 150, unit_price: 5.65 }] },
      { area: 'trim', items: [{ product_id: trim, pieces: 3, length_in: 126, width_in: 12, unit_price: 3.40 }] },
    ],
  };
  let res = await post('/orders', order);
  let out = await res.json();
  assert.ok(out.ok, out.error);
  const id = Number(out.redirect.split('/').pop());

  const lines = async () => (await query(
    'SELECT order_item_id, billable_qty, line_total FROM order_items WHERE order_id = $1 ORDER BY line_no', [id])).rows;
  const first = await lines();
  // 10 x 10' x 18" = 150 sq ft; 4 x 12.5' = 50 LF; 3 x 10.5' x 12" girth = 31.5 sq ft
  assert.deepStrictEqual(first.map((l) => l.billable_qty), [150, 50, 31.5]);
  const { rows: [t] } = await query('SELECT pre_tax_total FROM v_order_totals WHERE order_id = $1', [id]);
  assert.strictEqual(t.pre_tax_total, 547.5 + 282.5 + 107.1 + 50);

  // Edit: change the roof qty, drop the wall line.
  order.sections[0].items[0] = { ...order.sections[0].items[0], order_item_id: first[0].order_item_id, pieces: 12 };
  order.sections[1].items = [];
  order.sections[2].items[0].order_item_id = first[2].order_item_id;
  res = await post(`/orders/${id}`, order);
  out = await res.json();
  assert.ok(out.ok, out.error);
  const second = await lines();
  assert.deepStrictEqual(second.map((l) => l.order_item_id), [first[0].order_item_id, first[2].order_item_id]);
  assert.strictEqual(second[0].billable_qty, 180);
});

test('friendly errors for bad lines', async () => {
  const { rows: [c] } = await query(
    "INSERT INTO customers (display_name) VALUES ('Test ' || gen_random_uuid()) RETURNING customer_id");
  const snap = await productId('PNL-SL-26');
  const cases = [
    [{ product_id: snap, pieces: 2, unit_price: 3.65 }, /needs a length/],
    [{ product_id: snap, pieces: 2, length_in: 100, width_in: 24, unit_price: 3.65 }, /coverage must be between 16 and 18/],
    [{ product_id: await productId('TRM-GUTTER'), pieces: 2, unit_price: null }, /needs a price/],
  ];
  for (const [item, pattern] of cases) {
    const res = await post('/orders', { customer_id: c.customer_id, sections: [{ area: 'roof', items: [item] }] });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, pattern);
  }
});

test('status changes: approving needs a due date and sets the order date; completing locks editing', async () => {
  const { rows: [o] } = await query(`
    INSERT INTO orders (customer_id, ordered_on) SELECT customer_id, current_date - 5 FROM customers LIMIT 1
    RETURNING order_id`);
  const setStatus = (body) => fetch(`${base}/orders/${o.order_id}/status`, {
    method: 'POST', body: new URLSearchParams(body), redirect: 'manual',
  });
  let res = await setStatus({ status: 'completed' });
  assert.match(res.headers.get('location'), /status_error=.*Need-by/);
  assert.strictEqual((await query('SELECT status FROM orders WHERE order_id = $1', [o.order_id])).rows[0].status, 'quote');
  res = await setStatus({ status: 'completed', need_by: '2030-01-15' });
  assert.strictEqual(res.status, 302);
  const { rows: [after] } = await query(`SELECT status, completed_at, need_by, ordered_on = current_date AS today
    FROM orders WHERE order_id = $1`, [o.order_id]);
  assert.strictEqual(after.status, 'completed');
  assert.strictEqual(after.need_by, '2030-01-15');
  assert.ok(after.today);
  assert.ok(after.completed_at);
  const edit = await post(`/orders/${o.order_id}`, { customer_id: 1, sections: [] });
  assert.strictEqual(edit.status, 400);
});

test('health check answers', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.match(await res.text(), /^ok/);
});

test('colors are per supplier, and textured premiums price the line', async () => {
  const tag = Math.random().toString(36).slice(2, 8);
  const form = (path, body) => fetch(base + path, { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
  await form('/suppliers', { name: `Sup A ${tag}` });
  await form('/suppliers', { name: `Sup B ${tag}` });
  const { rows: sups } = await query('SELECT supplier_id FROM suppliers WHERE name LIKE $1 ORDER BY name', [`% ${tag}`]);
  const [a, b] = sups.map((s) => s.supplier_id);
  // Same name from two suppliers is allowed; twice from one supplier is not.
  await form('/colors', { supplier_id: a, name: 'Charcoal', finish: 'smooth', upcharge_pct: 0 });
  await form('/colors', { supplier_id: b, name: 'Charcoal', finish: 'smooth', upcharge_pct: 0 });
  const dup = await form('/colors', { supplier_id: a, name: 'Charcoal', finish: 'smooth', upcharge_pct: 0 });
  assert.match(decodeURIComponent(dup.headers.get('location')), /already on the list/);
  await form('/colors', { supplier_id: b, name: 'Crinkle Black', finish: 'textured', upcharge_pct: 12 });
  await form('/colors', { supplier_id: a, name: 'Copper', finish: 'metallic', upcharge_pct: 8 });
  const { rows } = await query(`SELECT color_id, label FROM v_colors WHERE supplier_id IN ($1, $2) ORDER BY label`, [a, b]);
  assert.deepStrictEqual(rows.map((r) => r.label),
    [`Charcoal (Sup A ${tag})`, `Charcoal (Sup B ${tag})`, `Copper (Sup A ${tag}, Metallic)`,
      `Crinkle Black (Sup B ${tag}, Textured)`]);

  // The database applies the premium when a line is priced from the price list (3.65 x 1.12).
  const { rows: [c] } = await query(
    "INSERT INTO customers (display_name) VALUES ('Test ' || gen_random_uuid()) RETURNING customer_id");
  const { rows: [o] } = await query('INSERT INTO orders (customer_id) VALUES ($1) RETURNING order_id', [c.customer_id]);
  const { rows: [line] } = await query(`
    INSERT INTO order_items (order_id, product_id, color_id, pieces, length_in)
    SELECT $1, product_id, $2, 1, 120 FROM products WHERE sku = 'PNL-SL-26' RETURNING unit_price`,
  [o.order_id, rows[3].color_id]);
  assert.strictEqual(line.unit_price, 4.09);
  const page = await (await fetch(`${base}/orders/new`)).text();
  assert.match(page, /Crinkle Black/);
});

test('one supplier can list the same color in several finishes; new finishes can be added', async () => {
  const tag = Math.random().toString(36).slice(2, 8);
  const form = (path, body) => fetch(base + path, { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
  await form('/suppliers', { name: `CMG ${tag}` });
  const { rows: [s] } = await query('SELECT supplier_id FROM suppliers WHERE name = $1', [`CMG ${tag}`]);
  await form('/colors', { supplier_id: s.supplier_id, name: 'Charcoal', finish: 'smooth' });
  await form('/colors', { supplier_id: s.supplier_id, name: 'Charcoal', finish: 'pvdf_heat_reflective', upcharge_pct: 10 });
  const dup = await form('/colors', { supplier_id: s.supplier_id, name: 'Charcoal', finish: 'pvdf_heat_reflective' });
  assert.match(decodeURIComponent(dup.headers.get('location')), /already on the list/);
  const { rows } = await query('SELECT label FROM v_colors WHERE supplier_id = $1 ORDER BY finish_sort', [s.supplier_id]);
  assert.deepStrictEqual(rows.map((r) => r.label),
    [`Charcoal (CMG ${tag})`, `Charcoal (CMG ${tag}, PVDF heat-reflective)`]);

  await form('/finishes', { label: `Matte ${tag}` });
  const page = await (await fetch(`${base}/colors`)).text();
  assert.match(page, new RegExp(`Matte ${tag}`));
  assert.match(page, /Premium/);
});

test('coils by linear foot: receive, run against an order line, mismatch check, undo, correct, stock', async () => {
  const tag = Math.random().toString(36).slice(2, 8);
  const form = (path, body) => fetch(base + path, { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
  const errorOf = (res) => new URL(res.headers.get('location'), base).searchParams.get('error');
  const ids = async (sql, params) => (await query(sql, params)).rows[0];

  await form('/suppliers', { name: `Inv ${tag}` });
  const { supplier_id: sup } = await ids('SELECT supplier_id FROM suppliers WHERE name = $1', [`Inv ${tag}`]);
  await form('/colors', { supplier_id: sup, name: 'Slate', finish: 'smooth' });
  await form('/colors', { supplier_id: sup, name: 'Slate', finish: 'textured' });
  const { color_id: slate } = await ids("SELECT color_id FROM colors WHERE supplier_id = $1 AND finish = 'smooth'", [sup]);
  const { color_id: slateTx } = await ids("SELECT color_id FROM colors WHERE supplier_id = $1 AND finish = 'textured'", [sup]);
  const { gauge_id: g26 } = await ids('SELECT gauge_id FROM gauges WHERE gauge = 26');

  let res = await form('/coils', { coil_tag: `C-${tag}`, color_id: slate, gauge_id: g26, width_in: 20, initial_lf: 1500 });
  assert.strictEqual(res.status, 302);
  const coil = await ids('SELECT coil_id, supplier_id, current_lf FROM coils WHERE coil_tag = $1', [`C-${tag}`]);
  assert.strictEqual(coil.supplier_id, sup); // supplier comes from the color
  assert.strictEqual(coil.current_lf, 1500);
  res = await form('/coils', { coil_tag: `C-${tag}`, color_id: slate, gauge_id: g26, width_in: 20, initial_lf: 10 });
  assert.match(errorOf(res), /already in the system/);

  // Order with a Snap Lock 26 line in Slate (smooth): 10 pcs @ 12'.
  const { customer_id: cust } = await ids(
    "INSERT INTO customers (display_name) VALUES ('Test ' || gen_random_uuid()) RETURNING customer_id");
  const { order_id: oid } = await ids("INSERT INTO orders (customer_id, status) VALUES ($1, 'confirmed') RETURNING order_id", [cust]);
  const { order_item_id: item } = await ids(`
    INSERT INTO order_items (order_id, product_id, color_id, pieces, length_in)
    SELECT $1, product_id, $2, 10, 144 FROM products WHERE sku = 'PNL-SL-26' RETURNING order_item_id`, [oid, slate]);

  // A textured-Slate coil doesn't match the smooth-Slate line.
  await form('/coils', { coil_tag: `T-${tag}`, color_id: slateTx, gauge_id: g26, width_in: 20, initial_lf: 800 });
  const tx2 = await ids('SELECT coil_id FROM coils WHERE coil_tag = $1', [`T-${tag}`]);
  res = await form(`/orders/${oid}/runs`, { order_item_id: item, coil_id: tx2.coil_id, pieces: 10, ft: '12', inch: '' });
  assert.match(errorOf(res), /Use this coil anyway/);

  // Matching coil: 10 x 12' = 120 LF + 3 LF scrap.
  res = await form(`/orders/${oid}/runs`, { order_item_id: item, coil_id: coil.coil_id, pieces: 10, ft: '12', inch: '', scrap_lf: 3 });
  assert.strictEqual(errorOf(res), null);
  let c = await ids('SELECT current_lf FROM coils WHERE coil_id = $1', [coil.coil_id]);
  assert.strictEqual(c.current_lf, 1377);
  const o = await ids('SELECT status FROM orders WHERE order_id = $1', [oid]);
  assert.strictEqual(o.status, 'in_production');
  const page = await (await fetch(`${base}/orders/${oid}`)).text();
  assert.match(page, new RegExp(`C-${tag}`));

  // Too much footage is refused with the coil's balance.
  res = await form(`/orders/${oid}/runs`, { order_item_id: item, coil_id: coil.coil_id, pieces: 10, ft: '12', lf_used: 5000 });
  assert.match(errorOf(res), /has only 1377 LF left/);

  // Undo puts it back.
  const run = await ids('SELECT production_run_id FROM production_runs WHERE order_item_id = $1', [item]);
  await form(`/runs/${run.production_run_id}/undo`, { back: `/orders/${oid}` });
  c = await ids('SELECT current_lf FROM coils WHERE coil_id = $1', [coil.coil_id]);
  assert.strictEqual(c.current_lf, 1500);

  // Measured correction, then stock cut from the coil: 4 pcs @ 10' 6" = 42 LF.
  await form(`/coils/${coil.coil_id}/correct`, { actual_lf: 1450 });
  const { product_id: pbr } = await ids("SELECT product_id FROM products WHERE sku = 'PNL-SL-26'");
  res = await form('/stock', { product_id: pbr, color_id: slate, qty: 4, ft: '10', inch: '6', coil_id: coil.coil_id });
  assert.strictEqual(errorOf(res), null);
  c = await ids('SELECT current_lf FROM coils WHERE coil_id = $1', [coil.coil_id]);
  assert.strictEqual(c.current_lf, 1408);
  const fg = await ids('SELECT finished_good_id, qty_on_hand FROM finished_goods WHERE color_id = $1', [slate]);
  assert.strictEqual(fg.qty_on_hand, 4);
  res = await form(`/stock/${fg.finished_good_id}/remove`, { qty: 9, reason: 'sell' });
  assert.match(errorOf(res), /aren't that many/);
  await form(`/stock/${fg.finished_good_id}/remove`, { qty: 3, reason: 'sell' });
  assert.strictEqual((await ids('SELECT qty_on_hand FROM finished_goods WHERE finished_good_id = $1', [fg.finished_good_id])).qty_on_hand, 1);

  // Closing the coil zeroes it out.
  await form(`/coils/${coil.coil_id}/close`, { reason: 'used_up' });
  c = await ids('SELECT current_lf, status FROM coils WHERE coil_id = $1', [coil.coil_id]);
  assert.deepStrictEqual([c.current_lf, c.status], [0, 'depleted']);
  for (const p of ['/coils', '/coils?show=all', `/coils/${coil.coil_id}`, '/stock']) {
    assert.strictEqual((await fetch(base + p)).status, 200, p);
  }
});

test('trim at custom lengths bills in 10\' pieces, up to 20\'; trim footage counts pieces across the coil', async () => {
  const { rows: [c] } = await query(
    "INSERT INTO customers (display_name) VALUES ('Test ' || gen_random_uuid()) RETURNING customer_id");
  const ridge = await productId('TRM-RIDGE-26');
  const ds = await productId('DS-3X4');
  const order = (items) => ({ customer_id: c.customer_id, sections: [{ area: 'trim', items }] });
  // 6 pcs @ 12' = 7.2 x 10' at $44.20; 3 pcs no length = 3; downspout 4 @ 20' = 8 x 10' at $15.
  let res = await post('/orders', order([
    { product_id: ridge, pieces: 6, length_in: 144, unit_price: 44.20 },
    { product_id: ridge, pieces: 3, unit_price: 44.20 },
    { product_id: ds, pieces: 4, length_in: 240, unit_price: 15 },
  ]));
  const out = await res.json();
  assert.ok(out.ok, out.error);
  const id = Number(out.redirect.split('/').pop());
  const { rows } = await query('SELECT billable_qty, line_total FROM order_items WHERE order_id = $1 ORDER BY line_no', [id]);
  assert.deepStrictEqual(rows.map((r) => [r.billable_qty, r.line_total]), [[7.2, 318.24], [3, 132.6], [8, 120]]);
  const { rows: [inv] } = await query('SELECT qbo_description FROM v_order_invoice_lines WHERE order_id = $1 AND line_no = 1', [id]);
  assert.match(inv.qbo_description, /6 pcs @ 12' 0" = 7.2 x 10' 0" lengths/);
  assert.match(await (await fetch(`${base}/orders/${id}`)).text(), /7\.2 × 10&#39;/);

  res = await post('/orders', order([{ product_id: ridge, pieces: 1, length_in: 252, unit_price: 44.20 }]));
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /at most 20'/);

  // Footage: girth 12" on a 48" coil = 4 across; 10 pcs @ 10' -> 3 strips x 10' = 30 LF.
  const { footage } = require('../src/production');
  assert.strictEqual(footage(10, 120, { girth: 12, coilWidth: 48 }), 30);
  assert.strictEqual(footage(10, 120), 100);
  assert.strictEqual(footage(2, 120, { girth: 60, coilWidth: 48 }), 20);

  const prices = await (await fetch(`${base}/products`)).text();
  assert.match(prices, /Downspout 3&quot;x4&quot;/);
  assert.match(prices, /Short Offset Elbow 3&quot;x4&quot; B style/);
  assert.match(prices, /per 10' piece/);
});

test('shop board shows counts and the next orders by due date', async () => {
  const res = await fetch(base + '/board');
  assert.strictEqual(res.status, 200);
  const page = await res.text();
  assert.match(page, /Quotes out/);
  assert.match(page, /Approved, waiting/);
  assert.match(page, /Next up/);
  assert.match(page, /Coil check/);
  assert.match(page, /Ready and waiting/);
  assert.match(page, /This week:/);
  assert.match(page, /http-equiv="refresh"/);
  const { rows: [c] } = await query(`SELECT count(*) AS n FROM orders WHERE status = 'in_production'`);
  assert.match(page, new RegExp(`<div class="n">${c.n}</div><div class="label">In production`));
});

test('shop board flags an approved job that needs more coil than is on hand', async () => {
  const { rows: [col] } = await query(`INSERT INTO colors (name, finish) VALUES ('Board Test ' || gen_random_uuid(), 'smooth')
    RETURNING color_id, name`);
  const { rows: [g] } = await query(`SELECT gauge_id FROM products WHERE sku = 'PNL-PBR-26'`);
  await query(`INSERT INTO coils (coil_tag, gauge_id, color_id, width_in, initial_lf, current_lf)
    VALUES ('BT-' || gen_random_uuid(), $1, $2, 48, 100, 100)`, [g.gauge_id, col.color_id]);
  const { rows: [cust] } = await query(`INSERT INTO customers (display_name) VALUES ('Board ' || gen_random_uuid()) RETURNING customer_id`);
  const { rows: [o] } = await query(`INSERT INTO orders (customer_id, status, need_by) VALUES ($1, 'confirmed', DATE '2000-01-01' - (SELECT count(*) FROM orders)::int)
    RETURNING order_id`, [cust.customer_id]);
  // 10 pieces x 20' = 200 ft needed, 100 ft on hand. The due date sorts it ahead of
  // anything earlier test runs left behind.
  await query(`INSERT INTO order_items (order_id, product_id, color_id, pieces, length_in)
    VALUES ($1, $2, $3, 10, 240)`, [o.order_id, await productId('PNL-PBR-26'), col.color_id]);
  const page = await (await fetch(base + '/board')).text();
  assert.match(page, new RegExp(`${col.name}[^<]*<span class="ga">26 ga</span> <b>200 ft</b> <em>short 100 ft</em>`));
});

test('ridge cap at other widths: $ per finished inch x flat width (finished + 1"); 13" stays list', async () => {
  const { rows: [c] } = await query(
    "INSERT INTO customers (display_name) VALUES ('Test ' || gen_random_uuid()) RETURNING customer_id");
  const ridge = await productId('TRM-RIDGE-26');
  const { rows: [p] } = await query('SELECT girth_in, flat_extra_in FROM products WHERE product_id = $1', [ridge]);
  assert.deepStrictEqual(p, { girth_in: 14, flat_extra_in: 1 });
  const order = (items) => ({ customer_id: c.customer_id, sections: [{ area: 'trim', items }] });
  // $44.20 / 13" = $3.40 per inch; a 24" piece takes 25" of flat: 10 x 25/13 = 19.2308 ($85.00 each);
  // 4 @ 24" x 12' = 4 x 1.2 x 25/13 = 9.2308; 2 @ 13" (standard) = 2 at list.
  const res = await post('/orders', order([
    { product_id: ridge, pieces: 10, width_in: 24, unit_price: 44.20 },
    { product_id: ridge, pieces: 4, length_in: 144, width_in: 24, unit_price: 44.20 },
    { product_id: ridge, pieces: 2, width_in: 13, unit_price: 44.20 },
  ]));
  const out = await res.json();
  assert.ok(out.ok, out.error);
  const id = Number(out.redirect.split('/').pop());
  const lines = async () => (await query(`SELECT order_item_id, width_in, per_width_in, billable_qty, line_total
    FROM order_items WHERE order_id = $1 ORDER BY line_no`, [id])).rows;
  let rows = await lines();
  assert.deepStrictEqual(rows.map((r) => [r.billable_qty, r.line_total]), [[19.2308, 850], [9.2308, 408], [2, 88.4]]);
  assert.strictEqual(rows[0].per_width_in, 13);
  assert.strictEqual(rows[2].per_width_in, null);
  const { rows: [inv] } = await query('SELECT qbo_description FROM v_order_invoice_lines WHERE order_id = $1 AND line_no = 1', [id]);
  assert.match(inv.qbo_description, /10 pcs @ 10' 0" x 24" wide = 19.2308 x 13" x 10' 0" pieces/);
  const page = await (await fetch(`${base}/orders/${id}`)).text();
  assert.match(page, /24&quot; wide \(25&quot; flat\)/);
  assert.match(page, /19\.23 × 13&quot; × 10&#39;/);
  // A 25" strip fits once across a 48" coil: 10 pieces x 10' = 100 ft.
  const { footage } = require('../src/production');
  assert.strictEqual(footage(10, 120, { girth: 25, coilWidth: 48 }), 100);

  // Saving again (as the edit form does) keeps the same lines and widths.
  const again = await post(`/orders/${id}`, order(rows.map((r, i) => ({
    order_item_id: r.order_item_id, product_id: ridge, pieces: [10, 4, 2][i],
    length_in: i === 1 ? 144 : null, width_in: r.width_in, unit_price: 44.20,
  }))));
  assert.ok((await again.json()).ok);
  rows = await lines();
  assert.deepStrictEqual(rows.map((r) => r.billable_qty), [19.2308, 9.2308, 2]);
});

test('sales tax on taxable materials after discount; exempt customers pay none; customer copy', async () => {
  const { rows: [c] } = await query(
    "INSERT INTO customers (display_name, email) VALUES ('Test ' || gen_random_uuid(), 'buyer@example.com') RETURNING customer_id");
  const ridge = await productId('TRM-RIDGE-26');
  const { rows: [col] } = await query(`INSERT INTO colors (name, supplier_id, finish)
    VALUES ('Tax Test ' || gen_random_uuid(), (SELECT min(supplier_id) FROM suppliers), 'textured') RETURNING color_id, name`);
  const { rows: [sup] } = await query('SELECT name FROM suppliers WHERE supplier_id = (SELECT min(supplier_id) FROM suppliers)');
  // $850.00 + $100 delivery - $16 discount; tax 6% on 850 - 16 = 834 -> $50.04.
  const res = await post('/orders', {
    customer_id: c.customer_id, tax_rate: 6, delivery_charge: 100, discount_amount: 16, job_name: 'Barn',
    sections: [{ area: 'trim', items: [{ product_id: ridge, color_id: col.color_id, pieces: 10, width_in: 24, unit_price: 44.20 }] }],
  });
  const out = await res.json();
  assert.ok(out.ok, out.error);
  const id = Number(out.redirect.split('/').pop());
  const totals = async () => (await query('SELECT pre_tax_total, tax_amount, grand_total FROM v_order_totals WHERE order_id = $1', [id])).rows[0];
  assert.deepStrictEqual(await totals(), { pre_tax_total: 934, tax_amount: 50.04, grand_total: 984.04 });

  const view = await (await fetch(`${base}/orders/${id}`)).text();
  assert.match(view, /Quote HP-/);
  assert.match(view, /Quoted \d/);
  assert.match(view, /Sales tax \(6%\)/);

  // Customer copy: price per piece, no billing column, no supplier.
  const copy = await (await fetch(`${base}/orders/${id}/customer`)).text();
  assert.match(copy, /QUOTE/);
  assert.match(copy, /\$85\.00/);
  assert.match(copy, /\$984\.04/);
  assert.match(copy, /24&quot; wide</);
  assert.match(copy, new RegExp(`${col.name} \\(Textured\\)`));
  assert.doesNotMatch(copy, new RegExp(sup.name));
  assert.doesNotMatch(copy, /Billed/);
  assert.match(copy, /mailto:buyer@example.com/);
  assert.match(copy, /https:\/\/mail\.google\.com\/mail\/\?view=cm&amp;fs=1&amp;to=buyer%40example\.com&amp;su=Quote\+HP-/);

  await query('UPDATE customers SET tax_exempt = true WHERE customer_id = $1', [c.customer_id]);
  await query('UPDATE orders SET tax_exempt = NULL WHERE order_id = $1', [id]);
  assert.deepStrictEqual(await totals(), { pre_tax_total: 934, tax_amount: 0, grand_total: 934 });
});

test('sized trim pricing setting picks the width basis', async () => {
  const ridge = await productId('TRM-RIDGE-26');
  const basis = async (mode, width = 24) => {
    await query("UPDATE app_settings SET value = $1 WHERE key = 'sized_trim_pricing'", [mode]);
    return (await query('SELECT * FROM fn_sized_trim_basis($1, $2)', [ridge, width])).rows[0];
  };
  try {
    assert.deepStrictEqual(await basis('per_inch', 13), { per_width: null, width_add: null }); // list price
    assert.deepStrictEqual(await basis('mixed'), { per_width: 13, width_add: 1 }); // 24" = 25/13 = $85.00
    assert.deepStrictEqual(await basis('finished'), { per_width: 13, width_add: 0 }); // 24/13
    assert.deepStrictEqual(await basis('flat'), { per_width: 14, width_add: 1 }); // 25/14
    assert.deepStrictEqual(await basis('per_inch'), { per_width: 13, width_add: 1 }); // 25/13 = $85.00
  } finally {
    await query("UPDATE app_settings SET value = 'per_inch' WHERE key = 'sized_trim_pricing'");
  }
});

test('drawings attach to an order line, show on the cut sheet, and stay when the line is removed', async () => {
  const { rows: [c] } = await query(
    "INSERT INTO customers (display_name) VALUES ('Test ' || gen_random_uuid()) RETURNING customer_id");
  const trim = await productId('TRM-CUST-26');
  const res = await post('/orders', { customer_id: c.customer_id, job_name: 'Drawing job',
    sections: [{ area: 'trim', items: [{ product_id: trim, pieces: 3, length_in: 120, width_in: 12, unit_price: 3.40 }] }] });
  const out = await res.json();
  assert.ok(out.ok, out.error);
  const id = Number(out.redirect.split('/').pop());
  const { rows: [line] } = await query('SELECT order_item_id FROM order_items WHERE order_id = $1', [id]);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  const bad = await fetch(`${base}/orders/${id}/attachments`, {
    method: 'POST', headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' });
  assert.strictEqual(bad.status, 400);

  const up = await fetch(`${base}/orders/${id}/attachments?line=${line.order_item_id}&note=Bend%20A%20first`, {
    method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('Eave trim.png') }, body: png });
  const { attachment_id: aid } = await up.json();
  assert.ok(aid);

  const page = await (await fetch(`${base}/orders/${id}`)).text();
  assert.match(page, /📎 Drawing: Eave trim\.png/);
  assert.match(page, /Line 1: /);
  assert.match(page, /Bend A first/);
  const file = await fetch(`${base}/orders/${id}/attachments/${aid}`);
  assert.strictEqual(file.headers.get('content-type'), 'image/png');
  assert.deepStrictEqual(Buffer.from(await file.arrayBuffer()), png);
  assert.doesNotMatch(await (await fetch(`${base}/orders/${id}/customer`)).text(), /Eave trim/);

  await query('DELETE FROM order_items WHERE order_id = $1', [id]);
  const { rows: [a] } = await query('SELECT order_id, order_item_id FROM order_attachments WHERE attachment_id = $1', [aid]);
  assert.deepStrictEqual(a, { order_id: id, order_item_id: null });

  await fetch(`${base}/orders/${id}/attachments/${aid}/delete`, { method: 'POST', redirect: 'manual' });
  assert.strictEqual((await query('SELECT 1 FROM order_attachments WHERE attachment_id = $1', [aid])).rowCount, 0);
});

test('sign-in: pages need an account, email + password signs in, wrong password does not', async () => {
  const anon = await fetch(`${base}/orders`, { anonymous: true, redirect: 'manual' });
  assert.strictEqual(anon.status, 302);
  assert.match(anon.headers.get('location'), /^\/login\?next=%2Forders/);
  assert.strictEqual((await fetch(`${base}/healthz`, { anonymous: true })).status, 200);

  const email = `Person-${Date.now()}@Example.com`;
  const form = (o) => new URLSearchParams(o).toString();
  const formPost = (path, o, extra = {}) => fetch(base + path, { method: 'POST', redirect: 'manual', ...extra,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(extra.headers || {}) }, body: form(o) });
  const add = await formPost('/users', { full_name: 'Pat Sales', email, role: 'sales', password: 'longenough1', perm: 'quotes' });
  assert.strictEqual(add.status, 302);
  const { rows: [u] } = await query('SELECT * FROM users WHERE email = lower($1)', [email]);
  assert.deepStrictEqual(u.permissions, ['quotes']);

  const bad = await formPost('/login', { email, password: 'wrong-password' }, { anonymous: true });
  assert.strictEqual(bad.status, 401);
  const good = await formPost('/login', { email: email.toUpperCase(), password: 'longenough1', next: '/customers' }, { anonymous: true });
  assert.strictEqual(good.status, 302);
  assert.strictEqual(good.headers.get('location'), '/customers');
  const cookie = good.headers.get('set-cookie').split(';')[0];
  const page = await (await fetch(`${base}/orders`, { headers: { cookie } })).text();
  assert.match(page, /Pat Sales/);
  assert.doesNotMatch(page, /href="\/admin"/);
  assert.strictEqual((await fetch(`${base}/users`, { headers: { cookie } })).status, 403);

  // Turning the account off signs them out.
  await formPost(`/users/${u.user_id}`, { full_name: 'Pat Sales', email, role: 'sales' });
  assert.strictEqual((await fetch(`${base}/orders`, { headers: { cookie }, redirect: 'manual' })).status, 302);
});

test('roles: production sees no prices and only moves orders along the shop steps', async () => {
  const prod = await signIn('production');
  const sales = await signIn('sales');
  const { rows: [c] } = await query(
    "INSERT INTO customers (display_name) VALUES ('Test ' || gen_random_uuid()) RETURNING customer_id");
  const res = await post('/orders', { customer_id: c.customer_id, need_by: '2030-01-01',
    sections: [{ area: 'wall', items: [{ product_id: await productId('PNL-PBR-26'), pieces: 4, length_in: 150, unit_price: 5.65 }] }] });
  const id = Number((await res.json()).redirect.split('/').pop());
  const as = (cookie, path, body) => fetch(base + path, { headers: { cookie }, redirect: 'manual',
    ...(body ? { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() } : {}) });
  const status = async () => (await query('SELECT status, approved_by FROM orders WHERE order_id = $1', [id])).rows[0];

  const page = await (await as(prod, `/orders/${id}`)).text();
  assert.doesNotMatch(page, /\$282\.50|Sales tax|Billed/);
  assert.doesNotMatch(page, /Edit quote|Customer quote/);
  for (const p of ['/orders/new', `/orders/${id}/customer`, '/products', '/admin']) {
    assert.strictEqual((await as(prod, p)).status, 403, p);
  }
  assert.strictEqual((await as(prod, '/settings/tax', { sales_tax_rate: '9' })).status, 403);
  assert.doesNotMatch(await (await as(prod, '/board')).text(), /quoted/);

  await as(prod, `/orders/${id}/status`, { status: 'confirmed' });
  assert.strictEqual((await status()).status, 'quote');
  await as(sales, `/orders/${id}/status`, { status: 'confirmed' });
  assert.deepStrictEqual(await status(), { status: 'confirmed', approved_by: 'Test sales' });
  await as(sales, `/orders/${id}/status`, { status: 'cancelled' });
  assert.strictEqual((await status()).status, 'confirmed');
  await as(prod, `/orders/${id}/status`, { status: 'in_production' });
  assert.strictEqual((await status()).status, 'in_production');
  await as(prod, `/orders/${id}/status`, { status: 'quote' });
  assert.strictEqual((await status()).status, 'in_production');
});

test('admin can add a product with a price and remove it', async () => {
  const name = `Test Gable ${Date.now()}`;
  const res = await fetch(`${base}/admin/products`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name, category: 'trim', pricing_unit: 'each', standard_ft: '10', max_ft: '20',
      girth_in: '9', unit_price: '31.5', taxable: '1' }).toString() });
  assert.strictEqual(res.status, 302);
  const { rows: [p] } = await query(`SELECT p.*, cp.unit_price FROM products p LEFT JOIN v_current_prices cp USING (product_id)
    WHERE name = $1`, [name]);
  assert.deepStrictEqual([p.standard_length_in, p.max_length_in, p.girth_in, p.unit_price], [120, 240, 9, 31.5]);
  await fetch(`${base}/admin/products/${p.product_id}/remove`, { method: 'POST', redirect: 'manual' });
  assert.strictEqual((await query('SELECT 1 FROM products WHERE product_id = $1', [p.product_id])).rowCount, 0);
});

test('screws: per-profile rules for through-fastener, nail flange and snap lock panels', async () => {
  const { rows: [c] } = await query(
    "INSERT INTO customers (display_name) VALUES ('Test ' || gen_random_uuid()) RETURNING customer_id");
  const [red, tan] = (await query(`INSERT INTO colors (name, finish) VALUES ('Screw Red ' || gen_random_uuid(), 'smooth'),
    ('Screw Tan ' || gen_random_uuid(), 'smooth') RETURNING color_id`)).rows.map((r) => r.color_id);
  const id_ = async (sku) => productId(sku);
  const [pbr, tuff, snap, nf] = await Promise.all(['PNL-PBR-26', 'PNL-TR-26', 'PNL-SL-26', 'PNL-NF-26'].map(id_));
  const [woodtite, long, selfDrill, panhead, clip] = await Promise.all(['SCR-10-1-5-WOODTITE-SCREWS',
    'SCR-2-1-2IN-WOODTITE-SCREW-1', 'SCR-SD-125', 'SCR-PANHEAD-1', 'ACC-CLIP-15'].map(id_));
  const order = (extra = {}) => ({
    customer_id: c.customer_id, auto_screws: true, framing: 'wood', ...extra,
    sections: [
      { area: 'roof', items: [
        // 20 @ 16'8" x 36" = 10 squares -> 900 screws -> 4 bags
        { product_id: pbr, color_id: red, pieces: 20, length_in: 200, unit_price: 5.65 },
        // snap lock 10 @ 10': 5 every-2' spots each -> 50 clips + 100 panheads
        { product_id: snap, color_id: red, pieces: 10, length_in: 120, width_in: 16, unit_price: 3.65 },
        // nail flange 6 @ 10'10": 6 spots each (rounded up) -> 36 panheads
        { product_id: nf, color_id: red, pieces: 6, length_in: 130, width_in: 16, unit_price: 3.65 }] },
      // 4 @ 12'6" x 36" = 1.5 squares -> 135 screws -> 1 bag
      { area: 'wall', items: [{ product_id: tuff, color_id: tan, pieces: 4, length_in: 150, unit_price: 5.65 }] },
      ...(extra.sections || []),
    ],
  });
  let res = await post('/orders', order());
  let out = await res.json();
  assert.ok(out.ok, out.error);
  const id = Number(out.redirect.split('/').pop());
  const screws = async () => (await query(`SELECT oi.product_id, oi.color_id, oi.pieces::int, oi.unit_price, oi.description,
      s.section_id, s.is_auto
    FROM order_items oi JOIN order_sections s USING (section_id)
    WHERE oi.order_id = $1 AND oi.product_id IN (SELECT product_id FROM products WHERE category IN ('fastener', 'accessory'))
    ORDER BY oi.line_no`, [id])).rows;
  let rows = await screws();
  assert.deepStrictEqual(rows.map((r) => [r.product_id, r.color_id, r.pieces, r.unit_price, r.is_auto]), [
    [woodtite, red, 4, 30, true], [clip, null, 50, 0.55, true], [panhead, red, 1, 38, true], [woodtite, tan, 1, 30, true]]);
  assert.match(rows[0].description, /^900 screws: 10 squares x 90 per square, 250 per bag$/);
  assert.match(rows[2].description, /^136 screws: 2 every 2' on 100' of panel \+ 1 every 2' on 65' of panel, 250 per bag$/);

  // Longer screws on wood; self drilling on steel. Standing seam is the same on both.
  res = await post(`/orders/${id}`, order({ screw_length: '2 1/2"' }));
  assert.ok((await res.json()).ok);
  rows = await screws();
  assert.deepStrictEqual(rows.map((r) => [r.product_id, r.pieces]), [[long, 4], [clip, 50], [panhead, 1], [long, 1]]);
  const sectionId = rows[0].section_id;
  res = await post(`/orders/${id}`, order({ framing: 'steel', sections: [{ section_id: sectionId, area: 'other', label: 'Screws', auto: true, items: [] }] }));
  assert.ok((await res.json()).ok);
  rows = await screws();
  assert.deepStrictEqual(rows.map((r) => [r.product_id, r.pieces, r.unit_price]), [[selfDrill, 4, 40], [clip, 50, 0.55], [panhead, 1, 38], [selfDrill, 1, 40]]);
  assert.strictEqual(rows[0].section_id, sectionId);

  // With it off, lines the form sends are kept as typed.
  res = await post(`/orders/${id}`, order({ auto_screws: false, sections: [{ area: 'other', label: 'Screws',
    items: [{ product_id: woodtite, color_id: red, pieces: 6, unit_price: 28 }] }] }));
  assert.ok((await res.json()).ok);
  rows = await screws();
  assert.deepStrictEqual(rows.map((r) => [r.pieces, r.unit_price, r.is_auto]), [[6, 28, false]]);

  const page = await (await fetch(`${base}/orders/${id}`)).text();
  assert.match(page, /#10 1\.5 Woodtite Screws/);
  assert.strictEqual((await fetch(`${base}/admin/screws`)).status, 200);
});

test('trim screws: own lines in the trim color, choice per line, quote picks the screw type', async () => {
  const { rows: [c] } = await query(
    "INSERT INTO customers (display_name) VALUES ('Test ' || gen_random_uuid()) RETURNING customer_id");
  const [red, tan] = (await query(`INSERT INTO colors (name, finish) VALUES ('Trim Red ' || gen_random_uuid(), 'smooth'),
    ('Trim Tan ' || gen_random_uuid(), 'smooth') RETURNING color_id`)).rows.map((r) => r.color_id);
  const [pbr, ridge, gable, woodtite, selfDrill] = await Promise.all(['PNL-PBR-26', 'TRM-RIDGE-26', 'TRM-GBL-2X4',
    'SCR-10-1-5-WOODTITE-SCREWS', 'SCR-SD-125'].map((s) => productId(s)));
  const trim = (ridgeOption) => ({ area: 'trim', items: [
    // 10 ridge cap @ 10': 2 every 18" -> 7 spots x 2 = 14 each = 140 (every 9": 14 x 2 = 28 each = 280)
    { product_id: ridge, color_id: tan, pieces: 10, width_in: 13, unit_price: 44.20, screw_option: ridgeOption },
    // 5 gable @ 10': 2 every 2' -> 10 each = 50
    { product_id: gable, color_id: tan, pieces: 5, length_in: 120, unit_price: 30 }] });
  const panels = { area: 'roof', items: [{ product_id: pbr, color_id: red, pieces: 20, length_in: 200, unit_price: 5.65 }] };
  const save = async (id, o) => (await post(id ? `/orders/${id}` : '/orders',
    { customer_id: c.customer_id, auto_screws: true, framing: 'wood', ...o })).json();
  let out = await save(null, { sections: [panels, trim()] });
  assert.ok(out.ok, out.error);
  const id = Number(out.redirect.split('/').pop());
  const screws = async () => (await query(`SELECT product_id, color_id, pieces::int, description FROM order_items
    WHERE order_id = $1 AND product_id IN (SELECT product_id FROM products WHERE category = 'fastener') ORDER BY line_no`, [id])).rows;
  let rows = await screws();
  assert.deepStrictEqual(rows.map((r) => [r.product_id, r.color_id, r.pieces]), [[woodtite, red, 4], [woodtite, tan, 1]]);
  assert.match(rows[1].description, /^190 screws for 10 Ridge Cap 26 GA, 5 Gable 2x4, 250 per bag$/);

  out = await save(id, { sections: [panels, trim('every 9"')] });
  assert.ok(out.ok, out.error);
  rows = await screws();
  assert.match(rows[1].description, /^330 screws/);
  assert.strictEqual(rows[1].pieces, 2);
  assert.strictEqual((await query("SELECT screw_option FROM order_items WHERE order_id = $1 AND product_id = $2", [id, ridge])).rows[0].screw_option, 'every 9"');

  out = await save(id, { framing: 'steel', sections: [panels, trim()] });
  assert.deepStrictEqual((await screws()).map((r) => [r.product_id, r.color_id]), [[selfDrill, red], [selfDrill, tan]]);

  // Trim with no panels: someone has to pick.
  out = await save(id, { sections: [trim()] });
  assert.match(out.error, /Pick which screws the trim gets/);
  out = await save(id, { trim_screws_for: 'through_fastened', sections: [trim()] });
  assert.ok(out.ok, out.error);
  assert.deepStrictEqual((await screws()).map((r) => [r.product_id, r.color_id, r.pieces]), [[woodtite, tan, 1]]);
  out = await save(id, { trim_screws_for: 'none', sections: [trim()] });
  assert.deepStrictEqual(await screws(), []);
  out = await save(id, { trim_screws_for: 'concealed', sections: [trim()] });
  assert.deepStrictEqual(await screws(), []); // no standing seam rules for these yet

  const manager = await signIn('manager');
  const sales = await signIn('sales');
  assert.strictEqual((await fetch(`${base}/admin/screws?for=i:${ridge}`, { headers: { cookie: manager } })).status, 200);
  assert.strictEqual((await fetch(`${base}/admin/screws`, { headers: { cookie: sales } })).status, 403);
});

test('reports: Admins and Managers only; status changes are logged; lost reasons and win rate count', async () => {
  const manager = await signIn('manager');
  const sales = await signIn('sales');
  const prod = await signIn('production');
  const as = (cookie, path, body) => fetch(base + path, { redirect: 'manual', ...(body
    ? { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() }
    : { headers: { cookie } }) });
  assert.strictEqual((await as(manager, '/reports')).status, 200);
  assert.strictEqual((await as(sales, '/reports')).status, 403);
  assert.strictEqual((await as(prod, '/reports')).status, 403);

  const name = `Report Co ${Date.now()}`;
  const { rows: [c] } = await query('INSERT INTO customers (display_name) VALUES ($1) RETURNING customer_id', [name]);
  const quote = async () => {
    const res = await post('/orders', { customer_id: c.customer_id, need_by: '2030-01-01',
      sections: [{ area: 'wall', items: [{ product_id: await productId('PNL-PBR-26'), pieces: 4, length_in: 150, unit_price: 5 }] }] });
    return Number((await res.json()).redirect.split('/').pop());
  };
  const won = await quote();
  const lostId = await quote();
  await as(manager, `/orders/${won}/status`, { status: 'confirmed' });
  await as(manager, `/orders/${lostId}/status`, { status: 'cancelled', lost_reason: 'price' });

  const { rows: hist } = await query(
    'SELECT from_status, to_status FROM order_status_history WHERE order_id = $1 ORDER BY history_id', [won]);
  assert.deepStrictEqual(hist, [{ from_status: null, to_status: 'quote' }, { from_status: 'quote', to_status: 'confirmed' }]);
  const { rows: [l] } = await query('SELECT lost_reason, approved_at, cancelled_at FROM orders WHERE order_id = $1', [lostId]);
  assert.strictEqual(l.lost_reason, 'price');
  assert.strictEqual(l.approved_at, null);
  assert.ok(l.cancelled_at);
  assert.ok((await query('SELECT approved_at FROM orders WHERE order_id = $1', [won])).rows[0].approved_at);

  const page = await (await as(manager, '/reports?range=month')).text();
  assert.match(page, /Quote win rate/);
  assert.match(page, /Price/);
  const csv = await (await as(manager, '/reports?range=month&csv=customers')).text();
  const row = csv.split('\r\n').find((r) => r.startsWith(name));
  // 4 panels x 12.5' = 50 ft at $5 = $250; 1 of 2 answered quotes won.
  assert.match(row, /,250,/);
  assert.match(row, /,50,/);
  assert.match((await as(manager, '/reports?range=month&csv=lost')).headers.get('content-type'), /text\/csv/);
});

test('supplies: receive, count, open orders, completed orders take them out and reopening puts them back', async () => {
  const boot = await productId('BOOT-1-ZIP');
  const screw = await productId('SCR-10-1-5-WOODTITE-SCREWS');
  const { rows: [col] } = await query("INSERT INTO colors (name) VALUES ('Supply ' || gen_random_uuid()) RETURNING color_id");
  const form = (path, body, cookie) => fetch(base + path, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body).toString() });
  const onHand = async (p, c) => (await query(
    'SELECT qty_on_hand FROM supply_stock WHERE product_id = $1 AND color_id IS NOT DISTINCT FROM $2', [p, c])).rows[0]?.qty_on_hand;
  const start = (await onHand(boot, null)) || 0;

  await form('/supplies', { product_id: boot, what: 'receive', qty: '10', note: 'PO 55' });
  assert.strictEqual(await onHand(boot, null), start + 10);
  await form('/supplies', { product_id: screw, color_id: col.color_id, what: 'count', qty: '6' });
  assert.strictEqual(await onHand(screw, col.color_id), 6);
  await form('/supplies', { product_id: screw, color_id: col.color_id, what: 'adjust', qty: '1' });
  assert.strictEqual(await onHand(screw, col.color_id), 5);
  assert.strictEqual((await form('/supplies', { product_id: boot, what: 'receive', qty: '1' }, await signIn('sales'))).status, 403);

  const { rows: [c] } = await query("INSERT INTO customers (display_name) VALUES ('Supply ' || gen_random_uuid()) RETURNING customer_id");
  const res = await post('/orders', { customer_id: c.customer_id, need_by: '2030-01-01', sections: [{ area: 'other', items: [
    { product_id: boot, pieces: 3, unit_price: 20 },
    { product_id: screw, color_id: col.color_id, pieces: 2, unit_price: 40 }] }] });
  const id = Number((await res.json()).redirect.split('/').pop());
  const setStatus = (status) => form(`/orders/${id}/status`, { status });

  await setStatus('confirmed');
  let page = await (await fetch(`${base}/supplies`)).text();
  assert.match(page, /On orders/);
  await setStatus('completed');
  assert.strictEqual(await onHand(boot, null), start + 7);
  assert.strictEqual(await onHand(screw, col.color_id), 3);
  await setStatus('completed'); // no double count
  assert.strictEqual(await onHand(boot, null), start + 7);
  await setStatus('ready'); // reopened: back on the shelf
  assert.strictEqual(await onHand(boot, null), start + 10);
  assert.strictEqual(await onHand(screw, col.color_id), 5);
  await setStatus('completed');
  assert.strictEqual(await onHand(screw, col.color_id), 3);

  const { rows: [s] } = await query('SELECT supply_id FROM supply_stock WHERE product_id = $1 AND color_id = $2', [screw, col.color_id]);
  await form(`/supplies/${s.supply_id}/settings`, { reorder_at: '4', location: 'Shelf B' });
  page = await (await fetch(`${base}/supplies?show=low`)).text();
  assert.match(page, /Woodtite/);
  page = await (await fetch(`${base}/supplies/${s.supply_id}`)).text();
  assert.match(page, /Shelf B/);
  assert.match(page, /Order completed/);
});

test('tools: add a tool with a new rental item, rent it on a quote, check it out and back in', async () => {
  const form = (path, body, cookie) => fetch(base + path, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body).toString() });
  const tag = `T${Date.now()}`;
  const rentalName = `Seamer ${tag} rental`;
  let res = await form('/tools', { name: 'Hand seamer', tag, rental_product_id: 'new', new_rental_name: rentalName, new_rental_price: '25' });
  assert.match(res.headers.get('location'), /^\/tools\/\d+\?saved=1$/);
  const toolId = Number(res.headers.get('location').match(/\d+/)[0]);
  const { rows: [p] } = await query('SELECT p.product_id, p.name, p.is_rental, cp.unit_price FROM products p JOIN v_current_prices cp USING (product_id) WHERE p.name = $1',
    [`${rentalName} (per day)`]);
  assert.strictEqual(p.is_rental, true);
  assert.strictEqual(p.unit_price, 25);
  res = await form('/tools', { name: 'Second seamer', tag, rental_product_id: p.product_id });
  assert.match(res.headers.get('location'), /error=.*tag/);
  const { rows: [shopTool] } = await query("INSERT INTO tools (name, rental_product_id) VALUES ('Spare seamer', $1) RETURNING tool_id", [p.product_id]);
  await query("UPDATE tools SET status = 'repair' WHERE tool_id = $1", [shopTool.tool_id]);

  const { rows: [c] } = await query("INSERT INTO customers (display_name) VALUES ('Renter ' || gen_random_uuid()) RETURNING customer_id");
  res = await post('/orders', { customer_id: c.customer_id, need_by: '2030-01-01', sections: [{ area: 'other', items: [
    { product_id: p.product_id, pieces: 3, unit_price: 25 }] }] });
  const id = Number((await res.json()).redirect.split('/').pop());
  const { rows: [line] } = await query('SELECT order_item_id, line_total FROM order_items WHERE order_id = $1', [id]);
  assert.strictEqual(line.line_total, 75);
  let page = await (await fetch(`${base}/orders/${id}`)).text();
  assert.match(page, /approve the quote to check it out/);

  await form(`/orders/${id}/status`, { status: 'confirmed' });
  page = await (await fetch(`${base}/orders/${id}`)).text();
  assert.match(page, /Picked up/);
  assert.doesNotMatch(page, /Spare seamer/); // in for repair
  res = await form(`/orders/${id}/rentals`, { order_item_id: line.order_item_id, tool_id: shopTool.tool_id, due_back: '2030-01-04' });
  assert.match(res.headers.get('location'), /rental_error/);
  res = await form(`/orders/${id}/rentals`, { order_item_id: line.order_item_id, tool_id: toolId, due_back: '2020-01-04' });
  assert.doesNotMatch(res.headers.get('location'), /rental_error/);
  res = await form(`/orders/${id}/rentals`, { order_item_id: line.order_item_id, tool_id: toolId, due_back: '2030-01-04' });
  assert.match(decodeURIComponent(res.headers.get('location')), /already out/);
  page = await (await fetch(`${base}/tools`)).text();
  assert.match(page, /Out with Renter/);
  assert.match(page, /overdue/);

  const { rows: [r] } = await query('SELECT rental_id FROM tool_rentals WHERE order_id = $1', [id]);
  await form(`/orders/${id}/rentals/${r.rental_id}/return`, { note: 'Good shape' });
  const { rows: [after] } = await query('SELECT returned_at, return_note FROM tool_rentals WHERE rental_id = $1', [r.rental_id]);
  assert.ok(after.returned_at);
  assert.strictEqual(after.return_note, 'Good shape');
  page = await (await fetch(`${base}/tools/${toolId}`)).text();
  assert.match(page, /Available/);
  assert.match(page, /Good shape/);
});

test('supply costs: receipts blend into an average cost; orders carry that cost into Reports', async () => {
  const form = (path, body, cookie) => fetch(base + path, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body).toString() });
  const { rows: [p] } = await query(`INSERT INTO products (sku, name, category, pricing_unit, taxable, track_stock)
    VALUES ('CAULK-' || gen_random_uuid(), 'Caulk ' || gen_random_uuid(), 'accessory', 'each', true, true) RETURNING product_id, name`);
  await query("INSERT INTO product_prices (product_id, unit_price, effective_from) VALUES ($1, 6, current_date - 1)", [p.product_id]);
  const stock = async () => (await query('SELECT supply_id, qty_on_hand, avg_cost FROM supply_stock WHERE product_id = $1', [p.product_id])).rows[0];
  await form('/supplies', { product_id: p.product_id, what: 'receive', qty: '10', unit_cost: '2' });
  await form('/supplies', { product_id: p.product_id, what: 'receive', qty: '10', unit_cost: '4' });
  assert.deepStrictEqual(await stock().then((s) => [s.qty_on_hand, s.avg_cost]), [20, 3]);
  // Production can count but can't set costs.
  await form('/supplies', { product_id: p.product_id, what: 'count', qty: '20', unit_cost: '99' }, await signIn('production'));
  assert.strictEqual((await stock()).avg_cost, 3);

  const { rows: [c] } = await query("INSERT INTO customers (display_name) VALUES ('Caulk ' || gen_random_uuid()) RETURNING customer_id");
  const res = await post('/orders', { customer_id: c.customer_id, need_by: '2030-01-01', sections: [{ area: 'other', items: [
    { product_id: p.product_id, pieces: 4, unit_price: 6 }] }] });
  const id = Number((await res.json()).redirect.split('/').pop());
  await form(`/orders/${id}/status`, { status: 'confirmed' });
  await form(`/orders/${id}/status`, { status: 'completed' });
  const { rows: [t] } = await query("SELECT qty_delta, unit_cost FROM supply_transactions WHERE order_id = $1", [id]);
  assert.deepStrictEqual([t.qty_delta, t.unit_cost], [-4, 3]);

  const s = await stock();
  assert.match(await (await fetch(`${base}/supplies/${s.supply_id}`)).text(), /50% margin/);
  const csv = await (await fetch(`${base}/reports?range=month&csv=supplies`)).text();
  const row = csv.split('\r\n').find((r) => r.startsWith(p.name));
  assert.match(row, /,4,each,12,24,50$/);
  assert.match(await (await fetch(`${base}/reports`)).text(), /Inventory at cost/);
});

test('barcodes: labels print, scans open the right page, pack and check catches wrong bundles', async () => {
  const form = (path, body, cookie) => fetch(base + path, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body).toString() });
  const { rows: [c] } = await query("INSERT INTO customers (display_name) VALUES ('Packer ' || gen_random_uuid()) RETURNING customer_id");
  const make = async () => {
    const res = await post('/orders', { customer_id: c.customer_id, need_by: '2030-01-01', sections: [{ area: 'wall', items: [
      { product_id: await productId('PNL-PBR-26'), pieces: 4, length_in: 150, unit_price: 5 },
      { product_id: await productId('BOOT-1-ZIP'), pieces: 2, unit_price: 20 }] }] });
    const id = Number((await res.json()).redirect.split('/').pop());
    const { rows } = await query('SELECT order_item_id FROM order_items WHERE order_id = $1 ORDER BY line_no', [id]);
    const { rows: [o] } = await query('SELECT order_number FROM orders WHERE order_id = $1', [id]);
    return { id, number: o.order_number, lines: rows.map((r) => r.order_item_id) };
  };
  const a = await make();
  const b = await make();

  const labels = await (await fetch(`${base}/labels/order/${a.id}`)).text();
  assert.match(labels, /<svg/);
  assert.match(labels, /<div class="code">B\d+<\/div>/);
  for (const p of ['/labels/coils', '/labels/supplies', '/labels/tools']) assert.strictEqual((await fetch(base + p)).status, 200, p);

  let res = await fetch(`${base}/scan?code=${encodeURIComponent(`https://www.hpcmcrm.net/s/${a.number}`)}`, { redirect: 'manual' });
  assert.strictEqual(res.headers.get('location'), `/orders/${a.id}`);
  res = await fetch(`${base}/s/L${a.lines[1]}`, { redirect: 'manual' });
  assert.strictEqual(res.headers.get('location'), `/orders/${a.id}/pack`);
  assert.strictEqual((await fetch(`${base}/scan?code=nope-123`)).status, 404);

  const pack = (code, extra = {}) => form(`/orders/${a.id}/pack`, { code, ...extra }).then((r) => decodeURIComponent(r.headers.get('location')));
  assert.match(await pack(`L${a.lines[0]}`), /isn't open for packing/); // still a quote
  await form(`/orders/${a.id}/status`, { status: 'confirmed' });
  assert.match(await pack(`L${b.lines[0]}`), new RegExp(`WRONG ORDER.*${b.number}`));
  assert.match(await pack(`https://www.hpcmcrm.net/s/L${a.lines[0]}`), /ok=Line 1.*1 to go/);
  assert.match(await pack(`L${a.lines[0]}`), /already checked/);
  res = await form(`/orders/${a.id}/pack/complete`, {});
  assert.match(decodeURIComponent(res.headers.get('location')), /aren't checked/);
  assert.match(await pack(`L${a.lines[1]}`), /All bundles checked/);
  assert.match(await (await fetch(`${base}/orders/${a.id}/pack`)).text(), /Mark order completed/);
  assert.strictEqual((await form(`/orders/${a.id}/pack`, { code: `L${a.lines[1]}` }, await signIn('sales'))).status, 403);
  await form(`/orders/${a.id}/pack/complete`, {});
  const { rows: [done] } = await query('SELECT status, inspected_by FROM orders WHERE order_id = $1', [a.id]);
  assert.strictEqual(done.status, 'completed');
  assert.ok(done.inspected_by);
  const { rows: [took] } = await query("SELECT count(*)::int AS n FROM supply_transactions WHERE order_id = $1 AND txn_type = 'order'", [a.id]);
  assert.strictEqual(took.n, 1);

  // Editing an order clears its checks.
  await form(`/orders/${b.id}/status`, { status: 'confirmed' });
  await form(`/orders/${b.id}/pack`, { code: `L${b.lines[0]}` });
  await post(`/orders/${b.id}`, { customer_id: c.customer_id, need_by: '2030-01-01', sections: [{ area: 'wall', items: [
    { order_item_id: b.lines[0], product_id: await productId('PNL-PBR-26'), pieces: 5, length_in: 150, unit_price: 5 }] }] });
  const { rows: [cleared] } = await query('SELECT count(*)::int AS n FROM order_items WHERE order_id = $1 AND packed_at IS NOT NULL', [b.id]);
  assert.strictEqual(cleared.n, 0);
});

test('bundles: drip edge splits into bundles of 10, the split can change, each bundle label is scanned', async () => {
  const form = (path, body) => fetch(base + path, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() })
    .then((r) => decodeURIComponent(r.headers.get('location') || ''));
  const { rows: [c] } = await query("INSERT INTO customers (display_name) VALUES ('Bundler ' || gen_random_uuid()) RETURNING customer_id");
  const res = await post('/orders', { customer_id: c.customer_id, need_by: '2030-01-01', sections: [{ area: 'trim', items: [
    { product_id: await productId('TRM-D-STYLE-90'), pieces: 26, length_in: 120, unit_price: 10 }] }] });
  const id = Number((await res.json()).redirect.split('/').pop());
  await form(`/orders/${id}/status`, { status: 'confirmed' });
  const page = await (await fetch(`${base}/orders/${id}/pack`)).text();
  assert.match(page, /value="10, 10, 6"/);
  const { rows: [line] } = await query('SELECT order_item_id FROM order_items WHERE order_id = $1', [id]);
  const bundles = async () => (await query('SELECT bundle_id, pieces FROM order_bundles WHERE order_item_id = $1 ORDER BY seq', [line.order_item_id])).rows;
  assert.deepStrictEqual((await bundles()).map((b) => b.pieces), [10, 10, 6]);
  const labels = await (await fetch(`${base}/labels/order/${id}`)).text();
  assert.match(labels, /bundle 3 of 3/);
  assert.match(labels, /6 × 10&#39; 0&quot; D style 90/);

  assert.match(await form(`/orders/${id}/pack`, { code: `L${line.order_item_id}` }), /in 3 bundles/);
  assert.match(await form(`/orders/${id}/pack/bundles`, { order_item_id: line.order_item_id, split: '13, 12' }), /add up to 25/);
  assert.match(await form(`/orders/${id}/pack/bundles`, { order_item_id: line.order_item_id, split: '12' }),
    /3 bundles: 12 \+ 12 \+ 2.*12 per bundle is now the usual/);
  assert.strictEqual((await query('SELECT bundle_size FROM products WHERE product_id = $1', [await productId('TRM-D-STYLE-90')])).rows[0].bundle_size, 12);
  await query("UPDATE products SET bundle_size = 10 WHERE sku = 'TRM-D-STYLE-90'");
  assert.match(await form(`/orders/${id}/pack/bundles`, { order_item_id: line.order_item_id, split: '13, 13' }), /2 bundles: 13 \+ 13/);
  const [b1, b2] = await bundles();
  assert.match(await form(`/orders/${id}/pack`, { code: `B${b1.bundle_id}` }), /bundle 1 of 2.*1 to go/);
  assert.match(await form(`/orders/${id}/pack/bundles`, { order_item_id: line.order_item_id, split: '26' }), /already has checked bundles/);
  assert.match(await form(`/orders/${id}/pack`, { code: `https://www.hpcmcrm.net/s/B${b2.bundle_id}` }), /All bundles checked/);
  assert.ok((await query('SELECT packed_at FROM order_items WHERE order_item_id = $1', [line.order_item_id])).rows[0].packed_at);
  await form(`/orders/${id}/pack/complete`, {});
  assert.strictEqual((await query('SELECT status FROM orders WHERE order_id = $1', [id])).rows[0].status, 'completed');
});
