// Figures the automatic Screws (and Closures) sections of quotes again, as if someone
// opened each one and pressed Save. Used when new screw rules should reach quotes already
// written (Board & Batten screws, Tyler 2026-11-24): a migration marks the quotes with
// orders.refigure_screws, and the app does them once it starts.
// The quote keeps who last changed it and the customer's answer; only its lines change.
const { query } = require('./db');

const DIMS = /^Top ([\d.]+)" x ([\d.]+)", sides ([\d.]+)"$/;

// A saved quote back into what the quote form sends.
function bodyFromOrder(o) {
  const keys = ['customer_id', 'customer_login_id', 'job_name', 'po_number', 'sales_rep', 'job_address_text', 'contact_phone',
    'contact_email', 'fulfillment', 'need_by', 'auto_screws', 'framing', 'screw_length', 'trim_screws_for', 'closures',
    'accessories_checked', 'closure_qty', 'delivery_charge', 'discount_amount', 'deposit_amount', 'tax_rate', 'tax_exempt',
    'customer_memo', 'internal_notes', 'completed_by', 'inspected_by'];
  const body = Object.fromEntries(keys.map((k) => [k, o[k]]));
  body.sections = o.sections.map((s) => ({
    section_id: s.section_id, area: s.area, label: s.label, auto: s.is_auto === true,
    // In an automatic section, only lines someone added by hand are sent; the rest are figured.
    items: s.items.filter((i) => !s.is_auto || i.is_added).map((i) => {
      const d = i.dims && String(i.dims).match(DIMS);
      return {
        order_item_id: i.order_item_id, product_id: i.product_id, color_id: i.color_id, pieces: i.pieces,
        length_in: i.length_in, width_in: i.width_in, unit_price: i.unit_price, description: i.description,
        screw_option: i.screw_option, qbo_item_id: i.qbo_item_id, pitch: i.pitch,
        dims: d ? { top_l: d[1], top_w: d[2], side_h: d[3] } : null,
      };
    }),
  }));
  return body;
}

async function refigure(orderId) {
  const { loadOrder, saveOrder } = require('./routes/orders');
  const o = await loadOrder(orderId);
  if (!o || o.status !== 'quote') return false;
  const { rows: [keep] } = await query(`SELECT updated_by, customer_decision, customer_decided_at, customer_decided_by,
      customer_decision_note, customer_decline_reason FROM orders WHERE order_id = $1`, [orderId]);
  await saveOrder(orderId, bodyFromOrder(o), { who: keep.updated_by || 'CRM' });
  await query(`UPDATE orders SET updated_by = $2, customer_decision = $3, customer_decided_at = $4,
      customer_decided_by = $5, customer_decision_note = $6, customer_decline_reason = $7, refigure_screws = false
    WHERE order_id = $1`, [orderId, keep.updated_by, keep.customer_decision, keep.customer_decided_at,
    keep.customer_decided_by, keep.customer_decision_note, keep.customer_decline_reason]);
  return true;
}

// Every marked quote. One that can't be saved (say, a line with no price) is left as it
// was and unmarked, and logged.
async function refigureMarked() {
  const { rows } = await query('SELECT order_id FROM orders WHERE refigure_screws ORDER BY order_id');
  let done = 0;
  for (const { order_id: id } of rows) {
    try {
      if (await refigure(id)) done += 1;
    } catch (err) {
      console.error(`Refiguring screws on order ${id} failed:`, err.message);
    }
    await query('UPDATE orders SET refigure_screws = false WHERE order_id = $1', [id]);
  }
  if (rows.length) console.log(`Refigured screws on ${done} of ${rows.length} quotes.`);
  return { done, of: rows.length };
}

module.exports = { bodyFromOrder, refigure, refigureMarked };
