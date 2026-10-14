// Supplies on hand (boots, jacks, screws, accessories): shared by the Supplies
// page and the order status change that takes them out of stock.

// How much of a line comes out of stock: pieces for things sold by the each,
// bag or roll; the billed amount for anything sold by length or area.
const LINE_QTY = "CASE WHEN oi.pricing_unit IN ('each', 'bag', 'roll') THEN oi.pieces ELSE oi.billable_qty END";

// Supplies on an order come out of stock when it is completed (picked up or
// delivered) and go back if it is reopened. Works out the difference from what
// was already taken, so it can be run after any status change.
async function syncOrderSupplies(db, orderId, by) {
  const { rows } = await db.query(`
    WITH want AS (
      SELECT oi.product_id, CASE WHEN p.stock_by_color THEN oi.color_id END AS color_id, sum(${LINE_QTY}) AS qty
      FROM order_items oi JOIN products p USING (product_id) JOIN orders o USING (order_id)
      WHERE oi.order_id = $1 AND p.track_stock AND o.status IN ('completed', 'invoiced')
      GROUP BY 1, 2),
    took AS (
      SELECT s.product_id, s.color_id, -sum(t.qty_delta) AS qty
      FROM supply_transactions t JOIN supply_stock s USING (supply_id)
      WHERE t.order_id = $1 AND t.txn_type = 'order'
      GROUP BY 1, 2)
    SELECT COALESCE(w.product_id, k.product_id) AS product_id, COALESCE(w.color_id, k.color_id) AS color_id,
           COALESCE(w.qty, 0) - COALESCE(k.qty, 0) AS more
    FROM want w FULL JOIN took k ON k.product_id = w.product_id AND k.color_id IS NOT DISTINCT FROM w.color_id`, [orderId]);
  for (const r of rows) {
    if (!r.more) continue;
    const supplyId = await supplyRow(db, r.product_id, r.color_id);
    await db.query(`INSERT INTO supply_transactions (supply_id, txn_type, qty_delta, order_id, performed_by, note)
      VALUES ($1, 'order', $2, $3, $4, $5)`,
    [supplyId, -r.more, orderId, by, r.more > 0 ? 'Order completed' : 'Order reopened or changed']);
  }
}

// The stock row for a product (and color), made if it isn't there yet.
async function supplyRow(db, productId, colorId) {
  await db.query(`INSERT INTO supply_stock (product_id, color_id) VALUES ($1, $2)
    ON CONFLICT (product_id, color_id) DO NOTHING`, [productId, colorId || null]);
  const { rows: [s] } = await db.query(
    'SELECT supply_id FROM supply_stock WHERE product_id = $1 AND color_id IS NOT DISTINCT FROM $2', [productId, colorId || null]);
  return s.supply_id;
}

module.exports = { syncOrderSupplies, supplyRow, LINE_QTY };
