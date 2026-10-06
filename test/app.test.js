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

test('status changes: completing locks editing', async () => {
  const { rows: [o] } = await query(`
    INSERT INTO orders (customer_id) SELECT customer_id FROM customers LIMIT 1 RETURNING order_id`);
  const res = await fetch(`${base}/orders/${o.order_id}/status`, {
    method: 'POST', body: new URLSearchParams({ status: 'completed' }), redirect: 'manual',
  });
  assert.strictEqual(res.status, 302);
  const { rows: [after] } = await query('SELECT status, completed_at FROM orders WHERE order_id = $1', [o.order_id]);
  assert.strictEqual(after.status, 'completed');
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
