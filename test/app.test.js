// Integration tests. Need a database loaded with `npm run db:setup` (DATABASE_URL).
const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/server');
const { query, pool } = require('../src/db');

let base;
let server;
test.before(async () => {
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => {
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
