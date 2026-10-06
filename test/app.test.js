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
