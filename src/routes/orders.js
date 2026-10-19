// Orders: one order = one cut sheet. Sections (Roof / Wall / Trim / Other)
// hold the cut-sheet rows; billable sq ft / LF are computed by the database.
const express = require('express');
const { query, tx } = require('../db');
const { feetInches } = require('../length');
const { RUNNABLE, footage, runError } = require('../production');
const { syncOrderSupplies } = require('../supplies');
const qbo = require('../qbo');
const notices = require('../notices');
const proof = require('../proof');
const { can, need, userName, isAdmin } = require('../auth');
const Screws = require('../../public/screws');
const {
  html, raw, layout, money, num, date, statusBadge, UNIT_LABEL, STATUS_LABEL, AREA_LABEL, LOST_REASONS, deleteButton, typedDelete,
} = require('../html');

const router = require('../async-router')();

const EDITABLE = ['quote', 'confirmed', 'in_production', 'ready'];
// Statuses a person can pick. "invoiced" is set when the order goes to QuickBooks.
const SETTABLE = ['quote', 'confirmed', 'in_production', 'ready', 'completed', 'cancelled'];
const APPROVED = ['confirmed', 'in_production', 'ready', 'completed'];
const AREAS = ['roof', 'wall', 'trim', 'other'];

const TABS = {
  open: { label: 'Open', where: "o.status IN ('quote','confirmed','in_production','ready')" },
  quote: { label: 'Quotes', where: "o.status = 'quote'" },
  approved: { label: 'Customer approved', where: "o.status = 'quote' AND o.customer_decision = 'approved'" },
  shop: { label: 'In the shop', where: "o.status IN ('confirmed','in_production','ready')" },
  completed: { label: 'Completed', where: "o.status IN ('completed','invoiced')" },
  all: { label: 'All', where: 'true' },
};

// Safe to drop into a <script> tag.
const jsonForScript = (v) => raw(JSON.stringify(v).replace(/</g, '\\u003c'));

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadOrder(id) {
  const { rows: [order] } = await query(`
    SELECT o.*, c.display_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
           c.portal_enabled AS customer_portal,
           t.lines_subtotal, t.taxable_subtotal, t.pre_tax_total,
           t.tax_exempt AS tax_exempt_effective, t.tax_amount, t.grand_total,
           (o.created_at AT TIME ZONE 'America/Denver')::date AS quoted_on,
           COALESCE(o.quote_expires_on, (o.created_at AT TIME ZONE 'America/Denver')::date + 30) AS valid_until
    FROM orders o JOIN customers c USING (customer_id) JOIN v_order_totals t USING (order_id)
    WHERE o.order_id = $1`, [id]);
  if (!order) return null;
  const { rows: sections } = await query(
    'SELECT * FROM order_sections WHERE order_id = $1 ORDER BY sort_order, section_id', [id]);
  const { rows: items } = await query(`
    SELECT oi.*, p.name AS product_name, p.sku, p.category, p.is_rental, p.gauge_id AS product_gauge_id, p.girth_in AS product_girth_in,
           p.flat_extra_in AS product_flat_extra,
           g.gauge, col.label AS color_name,
           col.name || CASE WHEN col.finish <> 'smooth' THEN ' (' || col.finish_label || ')' ELSE '' END AS customer_color,
           fn_format_length(oi.length_in) AS length_display, ts.girth_in
    FROM order_items oi
    JOIN products p USING (product_id)
    LEFT JOIN gauges g ON g.gauge_id = p.gauge_id
    LEFT JOIN v_colors col ON col.color_id = oi.color_id
    LEFT JOIN order_item_trim_specs ts USING (order_item_id)
    WHERE oi.order_id = $1 ORDER BY oi.line_no`, [id]);
  for (const s of sections) s.items = items.filter((i) => i.section_id === s.section_id);
  const loose = items.filter((i) => !sections.some((s) => s.section_id === i.section_id));
  if (loose.length) sections.push({ section_id: null, area: 'other', label: null, items: loose });
  order.sections = sections;
  const { rows: attachments } = await query(`
    SELECT a.attachment_id, a.order_item_id, a.filename, a.content_type, a.byte_size, a.note, a.created_at, a.uploaded_by, a.from_customer, a.is_proof,
           oi.line_no, p.name AS product_name
    FROM order_attachments a
    LEFT JOIN order_items oi USING (order_item_id)
    LEFT JOIN products p ON p.product_id = oi.product_id
    WHERE a.order_id = $1 ORDER BY oi.line_no NULLS FIRST, a.attachment_id`, [id]);
  // Length check photos are kept apart from drawings.
  order.photos = attachments.filter((a) => a.is_proof);
  order.attachments = attachments.filter((a) => !a.is_proof);
  for (const i of items) {
    i.attachments = order.attachments.filter((a) => a.order_item_id === i.order_item_id);
    i.photos = order.photos.filter((a) => a.order_item_id === i.order_item_id);
  }
  return order;
}

async function loadCatalog() {
  const { rows: products } = await query(`
    SELECT p.product_id AS id, p.name, p.category, p.pricing_unit AS unit, p.price_varies, p.taxable,
           p.is_cut_to_length, p.standard_length_in, p.max_length_in, p.girth_in AS girth,
           p.flat_extra_in AS flat_extra, cp.unit_price AS price,
           pp.coverage_width_in AS cov, pp.min_coverage_in AS cov_min, pp.max_coverage_in AS cov_max,
           pp.fastening::text AS fastening, p.profile_id, pp.name AS profile_name,
           pp.closure_product_id AS closure_id, pp.vented_closure_product_id AS vented_closure_id
    FROM products p
    LEFT JOIN v_current_prices cp USING (product_id)
    LEFT JOIN panel_profiles pp USING (profile_id)
    WHERE p.active AND p.category <> 'delivery'
    ORDER BY array_position(enum_range(NULL::product_category), p.category), p.name`);
  const { rows: colors } = await query(`
    SELECT color_id AS id, name, label, supplier_name AS supplier, finish, finish_label, upcharge_pct AS upcharge
    FROM v_colors WHERE active ORDER BY supplier_name NULLS FIRST, name, finish_sort`);
  const { rows: customers } = await query(`
    SELECT customer_id AS id, display_name AS name, phone, email, default_fulfillment, tax_exempt
    FROM customers WHERE active ORDER BY lower(display_name)`);
  const { rows: [sp] } = await query("SELECT value FROM app_settings WHERE key = 'sized_trim_pricing'");
  return {
    products, colors, customers, default_tax_rate: await defaultTaxRate(), sized_pricing: sp ? sp.value : 'per_inch',
    screw_rules: await loadScrewRules(),
  };
}

// Which screw goes with which panels and framing (Admin > Screws).
async function loadScrewRules(db = { query }) {
  const { rows } = await db.query(`
    SELECT r.profile_id, r.item_product_id, r.framing, r.panel_system, r.length_label, r.option_label, r.product_id,
           r.basis, r.qty, r.spacing_in, r.color_match, r.is_default,
           p.name AS product_name, p.pricing_unit::text AS unit, p.category::text AS category,
           p.pack_size, cp.unit_price AS price
    FROM screw_rules r LEFT JOIN products p USING (product_id) LEFT JOIN v_current_prices cp USING (product_id)
    ORDER BY r.profile_id, r.item_product_id, r.framing, r.sort_order, r.screw_rule_id`);
  return rows;
}

// ---------------------------------------------------------------------------
// Saving (JSON posted by public/order-form.js)
// ---------------------------------------------------------------------------
class UserError extends Error {}

const text = (v, max) => {
  if (typeof v !== 'string' || v.trim() === '') return null;
  if (max && v.trim().length > max) throw new UserError(`Text is too long (max ${max} characters).`);
  return v.trim();
};
const amount = (v, label) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UserError(`${label} must be zero or more.`);
  return Math.round(n * 100) / 100;
};
const blank = (v) => v === null || v === undefined || v === '';
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

async function defaultTaxRate() {
  const { rows: [r] } = await query("SELECT value FROM app_settings WHERE key = 'sales_tax_rate'");
  return r ? Number(r.value) : 0;
}

const taxRate = (v) => {
  const n = blank(v) ? 0 : Number(v);
  if (!Number.isFinite(n) || n < 0 || n >= 100) throw new UserError('Sales tax must be a percent from 0 to 99.');
  return Math.round(n * 1000) / 1000;
};

function parseHeader(b) {
  const customerId = Number(b.customer_id);
  if (!Number.isInteger(customerId) || customerId <= 0) throw new UserError('Pick a customer.');
  return {
    customer_id: customerId,
    job_name: text(b.job_name),
    po_number: text(b.po_number),
    job_address_text: text(b.job_address_text),
    contact_phone: text(b.contact_phone),
    contact_email: text(b.contact_email),
    fulfillment: b.fulfillment === 'delivery' ? 'delivery' : 'pickup',
    need_by: isoDate(b.need_by),
    auto_screws: b.auto_screws === true || b.auto_screws === 'true',
    framing: b.framing === 'steel' ? 'steel' : 'wood',
    screw_length: text(b.screw_length),
    trim_screws_for: ['through_fastened', 'concealed', 'none'].includes(b.trim_screws_for) ? b.trim_screws_for : null,
    closures: ['standard', 'vented'].includes(b.closures) ? b.closures : 'none',
    accessories_checked: b.accessories_checked === true || b.accessories_checked === 'true',
    delivery_charge: amount(b.delivery_charge, 'Delivery charge'),
    discount_amount: amount(b.discount_amount, 'Discount'),
    deposit_amount: amount(b.deposit_amount, 'Deposit'),
    tax_rate: taxRate(b.tax_rate),
    tax_exempt: blank(b.tax_exempt) ? null : b.tax_exempt === true || b.tax_exempt === 'true',
    customer_memo: text(b.customer_memo, 1000),
    internal_notes: text(b.internal_notes, 4000),
    completed_by: text(b.completed_by),
    inspected_by: text(b.inspected_by),
  };
}

function parseSections(b, productsById) {
  if (!Array.isArray(b.sections)) throw new UserError('The order has no sections.');
  return b.sections.map((s, si) => {
    const area = AREAS.includes(s.area) ? s.area : 'other';
    const where = (n) => `${AREA_LABEL[area]}${s.label ? ` (${s.label})` : ''}, line ${n}`;
    const items = (Array.isArray(s.items) ? s.items : []).map((it, ii) => {
      const p = productsById.get(Number(it.product_id));
      if (!p) throw new UserError(`${where(ii + 1)}: pick a product.`);
      const pieces = Number(it.pieces);
      if (!(pieces > 0)) throw new UserError(`${where(ii + 1)}: quantity must be more than zero.`);
      const length = blank(it.length_in) ? null : Number(it.length_in);
      if (length !== null && !(length > 0)) throw new UserError(`${where(ii + 1)}: length must be more than zero.`);
      if (length !== null && p.max_length_in && length > p.max_length_in) {
        throw new UserError(`${where(ii + 1)}: ${p.name} can be at most ${p.max_length_in / 12}' long.`);
      }
      if (['sqft', 'lf'].includes(p.unit) && length === null) {
        throw new UserError(`${where(ii + 1)}: ${p.name} needs a length.`);
      }
      let width = blank(it.width_in) ? null : Number(it.width_in);
      if (p.category === 'custom_trim' && !(width > 0)) {
        throw new UserError(`${where(ii + 1)}: enter the girth (flat width in inches) for custom trim.`);
      }
      // Trim with a standard flat width (ridge cap 13") can be made wider or narrower.
      const sized = p.unit === 'each' && p.girth > 0;
      if (width !== null && !(width > 0)) throw new UserError(`${where(ii + 1)}: width must be more than zero.`);
      if (p.category !== 'panel' && p.category !== 'custom_trim' && !sized) width = null;
      const price = blank(it.unit_price) ? null : Number(it.unit_price);
      if (price === null || !(price >= 0)) throw new UserError(`${where(ii + 1)}: ${p.name} needs a price.`);
      return {
        order_item_id: Number(it.order_item_id) || null,
        product: p,
        color_id: Number(it.color_id) || null,
        pieces,
        length_in: length,
        width_in: width,
        unit_price: price,
        description: text(it.description, 4000),
        screw_option: text(it.screw_option),
      };
    });
    return {
      section_id: Number(s.section_id) || null, area, label: text(s.label), sort_order: si + 1, items,
      is_auto: s.auto === true,
      is_closures: s.auto === true && s.label === 'Closures',
    };
  });
}

// With automatic screws on, the Screws section is rebuilt from the panel lines
// every save (whatever the form sent for it). With it off, the screw lines are
// ordinary lines the person can change.
async function withScrews(sections, header, productsById) {
  const auto = sections.find((s) => s.is_auto && !s.is_closures);
  const rest = withClosures(sections.filter((s) => !s.is_auto), sections.find((s) => s.is_closures), header, productsById);
  if (!header.auto_screws) {
    if (auto) rest.push({ ...auto, is_auto: false });
    return rest;
  }
  const lines = rest.flatMap((s) => s.items).map((i) => ({ ...i, product_id: i.product.id }));
  const { lines: screws, needsTrimChoice } = Screws.figure(lines, productsById, await loadScrewRules(),
    { framing: header.framing, length: header.screw_length, trimFor: header.trim_screws_for });
  if (needsTrimChoice) {
    throw new UserError('Pick which screws the trim gets ("Trim screws for", in the Screws section at the bottom).');
  }
  if (!screws.length) return rest;
  const items = screws.map((l) => {
    const p = productsById.get(l.product_id);
    if (l.unit_price === '') {
      throw new UserError(`${p.name} has no price yet. Set it on the Price list, or untick "Figure screws automatically".`);
    }
    if (!(l.pieces > 0)) {
      throw new UserError(`Couldn't figure ${p.name}. Untick "Figure screws automatically" and add them as lines.`);
    }
    return {
      order_item_id: null, product: p, color_id: l.color_id, pieces: l.pieces, length_in: null, width_in: null,
      unit_price: l.unit_price, description: l.description, screw_option: null,
    };
  });
  return [...rest, {
    section_id: auto ? auto.section_id : null, area: 'other', label: 'Screws',
    sort_order: rest.length + 1, items, is_auto: true,
  }];
}

// Closures for PBR and Tuff Rib panels (1 inside, 1 outside per panel) go in their own
// automatic section, rebuilt every save from the quote's "Closures" choice.
function withClosures(rest, auto, header, productsById) {
  const lines = rest.flatMap((s) => s.items).map((i) => ({ ...i, product_id: i.product.id }));
  const { lines: figured, missing } = Screws.closures(lines, productsById, header.closures);
  if (missing.length) {
    throw new UserError(`No ${header.closures === 'vented' ? 'vented ' : ''}closure is set up for ${missing.join(' or ')}. Pick "No closures" and add them as lines.`);
  }
  if (!figured.length) return rest;
  const items = figured.map((l) => {
    const p = productsById.get(l.product_id);
    if (l.unit_price === '') throw new UserError(`${p.name} has no price yet. Set it on the Price list, or pick "No closures".`);
    return {
      order_item_id: null, product: p, color_id: null, pieces: l.pieces, length_in: null, width_in: null,
      unit_price: l.unit_price, description: l.description, screw_option: null,
    };
  });
  return [...rest, {
    section_id: auto ? auto.section_id : null, area: 'other', label: 'Closures',
    sort_order: rest.length + 1, items, is_auto: true,
  }];
}

// `who` names the person saving when it isn't a staff sign-in (the customer portal).
async function saveOrder(orderId, body, { who = userName(), extra = {} } = {}) {
  const header = { ...parseHeader(body), ...extra };
  header.updated_by = who;
  if (!orderId) header.created_by = who;
  const { rows: prodRows } = await query(`
    SELECT p.product_id AS id, p.name, p.category, p.pricing_unit AS unit, p.taxable, p.max_length_in,
           p.girth_in AS girth, p.profile_id, pp.name AS profile_name, pp.coverage_width_in AS cov,
           pp.fastening::text AS fastening, p.standard_length_in,
           pp.closure_product_id AS closure_id, pp.vented_closure_product_id AS vented_closure_id, cp.unit_price AS price
    FROM products p LEFT JOIN panel_profiles pp USING (profile_id) LEFT JOIN v_current_prices cp USING (product_id)`);
  const productsById = new Map(prodRows.map((p) => [p.id, p]));
  const sections = await withScrews(parseSections(body, productsById), header, productsById);

  return tx(async (db) => {
    const cols = Object.keys(header);
    // What the customer approves: if the lines or charges change, they answer again.
    const fingerprint = async () => (await db.query(`
      SELECT (SELECT string_agg(concat_ws(':', product_id, color_id, pieces, length_in, width_in, unit_price), ',' ORDER BY line_no)
              FROM order_items WHERE order_id = $1) || '|' || t.grand_total AS f
      FROM v_order_totals t WHERE t.order_id = $1`, [orderId])).rows[0]?.f;
    const before = orderId ? await fingerprint() : null;
    if (orderId) {
      const { rows: [cur] } = await db.query('SELECT status FROM orders WHERE order_id = $1 FOR UPDATE', [orderId]);
      if (!cur) throw new UserError('Order not found.');
      if (!EDITABLE.includes(cur.status)) {
        throw new UserError(`This order is ${STATUS_LABEL[cur.status].toLowerCase()} and can't be edited. Reopen it first.`);
      }
      await db.query(`UPDATE orders SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}
                      WHERE order_id = $${cols.length + 1}`, [...cols.map((c) => header[c]), orderId]);
    } else {
      const { rows: [o] } = await db.query(`
        INSERT INTO orders (${cols.join(', ')}, quote_expires_on)
        VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, current_date + 30)
        RETURNING order_id`, cols.map((c) => header[c]));
      orderId = o.order_id;
    }

    // Lines and sections are updated in place (not deleted and re-added) so
    // that production records pointing at a line stay attached to it.
    const keepItems = sections.flatMap((s) => s.items.map((i) => i.order_item_id)).filter(Boolean);
    const keepSections = sections.map((s) => s.section_id).filter(Boolean);
    try {
      await db.query('DELETE FROM order_items WHERE order_id = $1 AND NOT (order_item_id = ANY($2::bigint[]))',
        [orderId, keepItems]);
    } catch (err) {
      if (err.code === '23503') throw new UserError('A line you removed already has production logged against it, so it can\'t be deleted.');
      throw err;
    }
    await db.query('DELETE FROM order_sections WHERE order_id = $1 AND NOT (section_id = ANY($2::bigint[]))',
      [orderId, keepSections]);
    // Park existing line numbers out of the way so renumbering can't collide.
    await db.query('UPDATE order_items SET line_no = -line_no WHERE order_id = $1', [orderId]);

    let lineNo = 0;
    for (const s of sections) {
      let sectionId = s.section_id;
      if (sectionId) {
        const r = await db.query(`UPDATE order_sections SET area = $1, label = $2, sort_order = $3, is_auto = $6
                                  WHERE section_id = $4 AND order_id = $5`,
        [s.area, s.label, s.sort_order, sectionId, orderId, !!s.is_auto]);
        if (!r.rowCount) sectionId = null;
      }
      if (!sectionId) {
        const { rows: [r] } = await db.query(`INSERT INTO order_sections (order_id, area, label, sort_order, is_auto)
                                              VALUES ($1, $2, $3, $4, $5) RETURNING section_id`,
        [orderId, s.area, s.label, s.sort_order, !!s.is_auto]);
        sectionId = r.section_id;
      }
      for (const it of s.items) {
        lineNo += 1;
        const vals = [sectionId, lineNo, it.product.id, it.color_id, it.pieces, it.length_in,
          it.width_in, it.unit_price, it.description, it.screw_option];
        let itemId = it.order_item_id;
        if (itemId) {
          const r = await db.query(`
            UPDATE order_items oi SET section_id = $1, line_no = $2, product_id = $3, color_id = $4,
                   pieces = $5, length_in = $6,
                   width_in = COALESCE($7, (SELECT pp.coverage_width_in FROM products p
                                            JOIN panel_profiles pp USING (profile_id)
                                            WHERE p.product_id = $3)),
                   unit_price = $8, description = $9, screw_option = $10,
                   pricing_unit = p.pricing_unit, taxable = p.taxable,
                   per_length_in = CASE WHEN p.pricing_unit = 'each' THEN p.standard_length_in END,
                   per_width_in = CASE WHEN p.pricing_unit = 'each' AND $7::numeric IS NOT NULL
                                       THEN (fn_sized_trim_basis(p.product_id, $7::numeric)).per_width END,
                   width_add_in = CASE WHEN p.pricing_unit = 'each' AND $7::numeric IS NOT NULL
                                       THEN (fn_sized_trim_basis(p.product_id, $7::numeric)).width_add END
            FROM products p
            WHERE p.product_id = $3 AND oi.order_item_id = $11 AND oi.order_id = $12`,
          [...vals, itemId, orderId]);
          if (!r.rowCount) itemId = null;
        }
        if (!itemId) {
          const { rows: [r] } = await db.query(`
            INSERT INTO order_items (order_id, section_id, line_no, product_id, color_id, pieces,
                                     length_in, width_in, unit_price, description, screw_option)
            VALUES ($11, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING order_item_id`, [...vals, orderId]);
          itemId = r.order_item_id;
        }
        if (it.product.category === 'custom_trim') {
          await db.query(`
            INSERT INTO order_item_trim_specs (order_item_id, girth_in) VALUES ($1, $2)
            ON CONFLICT (order_item_id) DO UPDATE SET girth_in = EXCLUDED.girth_in`, [itemId, it.width_in]);
        } else {
          await db.query('DELETE FROM order_item_trim_specs WHERE order_item_id = $1', [itemId]);
        }
      }
    }
    // Lines may have changed, so any pack checks have to be done again.
    await db.query('UPDATE order_items SET packed_at = NULL, packed_by = NULL WHERE order_id = $1 AND packed_at IS NOT NULL', [orderId]);
    await db.query(`UPDATE order_bundles b SET packed_at = NULL, packed_by = NULL FROM order_items oi
      WHERE oi.order_item_id = b.order_item_id AND oi.order_id = $1 AND b.packed_at IS NOT NULL`, [orderId]);
    // Bundles that no longer add up to their line's pieces are split again.
    await db.query(`DELETE FROM order_bundles b USING order_items oi
      WHERE oi.order_item_id = b.order_item_id AND oi.order_id = $1
        AND oi.pieces <> (SELECT sum(pieces) FROM order_bundles x WHERE x.order_item_id = oi.order_item_id)`, [orderId]);
    if (before && before !== await fingerprint()) {
      await db.query(`UPDATE orders SET customer_decision = NULL, customer_decided_at = NULL, customer_decided_by = NULL,
        customer_decision_note = NULL, customer_decline_reason = NULL WHERE order_id = $1 AND status = 'quote'`, [orderId]);
    }
    return orderId;
  });
}

const dbMessage = (err) => {
  if (err instanceof UserError) return err.message;
  if (err.code === 'P0001' || err.code === '23514') return err.message; // trigger / check messages
  return null;
};

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const tab = TABS[req.query.tab] ? req.query.tab : 'open';
  const q = (req.query.q || '').trim();
  const { rows } = await query(`
    SELECT o.order_id, o.order_number, o.job_name, o.po_number, o.status, o.ordered_on, o.need_by,
           o.fulfillment, o.customer_decision, c.display_name AS customer_name, t.grand_total
    FROM orders o JOIN customers c USING (customer_id) JOIN v_order_totals t USING (order_id)
    WHERE ${TABS[tab].where}
      AND ($1 = '' OR o.order_number ILIKE '%' || $1 || '%' OR o.job_name ILIKE '%' || $1 || '%'
           OR o.po_number ILIKE '%' || $1 || '%' OR c.display_name ILIKE '%' || $1 || '%')
    ORDER BY o.need_by NULLS LAST, o.order_id DESC`, [q]);
  const prices = can('prices');
  const { rows: [waiting] } = await query(`SELECT count(*)::int AS n FROM orders
    WHERE status = 'quote' AND customer_decision = 'approved'`);
  res.send(layout({
    title: 'Orders', active: '/orders',
    body: html`
    <div class="page-head">
      <h1>Orders</h1>
      ${can('quotes') ? html`<a class="btn primary" href="/orders/new">+ New quote</a>` : ''}
    </div>
    ${waiting.n && tab !== 'approved' && can('approve') ? html`<div class="notice">${waiting.n === 1 ? 'A customer approved a quote' : `Customers approved ${waiting.n} quotes`}
      in the portal. <a href="?tab=approved">Approve ${waiting.n === 1 ? 'it' : 'them'} for the shop</a>.</div>` : ''}
    <div class="tabs">${Object.entries(TABS).map(([k, t]) =>
      html`<a href="?tab=${k}" class="${k === tab ? 'active' : ''}">${t.label}</a>`)}</div>
    <form class="search"><input type="hidden" name="tab" value="${tab}">
      <input name="q" value="${q}" placeholder="Search order #, job, PO or customer"><button class="btn">Search</button></form>
    <table class="list">
      <thead><tr><th>Order #</th><th>Customer</th><th>Job</th><th>PO</th><th>Status</th>
        <th>Need by</th><th></th>${prices ? html`<th class="num">Total</th>` : ''}</tr></thead>
      <tbody>${rows.length ? rows.map((o) => html`
        <tr><td><a href="/orders/${o.order_id}">${o.order_number}</a></td><td>${o.customer_name}</td>
        <td>${o.job_name}</td><td>${o.po_number}</td><td>${statusBadge(o.status)}${o.status === 'quote' && o.customer_decision
          ? html` <span class="muted small">${o.customer_decision === 'approved' ? 'customer approved' : 'customer declined'}</span>` : ''}</td>
        <td>${date(o.need_by)}</td><td>${o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}</td>
        ${prices ? html`<td class="num">${money(o.grand_total)}</td>` : ''}</tr>`)
      : html`<tr><td colspan="8" class="empty">No orders here.</td></tr>`}</tbody>
    </table>`,
  }));
});

function formPage(res, { title, order, catalog }) {
  res.send(layout({
    title, active: '/orders',
    body: html`
    <h1>${title}</h1>
    <div id="order-form" class="order-form"><p class="muted">Loading…</p></div>
    <script>window.ORDER_FORM = ${jsonForScript({ order, ...catalog })};</script>`,
    scripts: ['/screws.js', '/order-form.js'],
  }));
}

router.get('/new', need('quotes'), async (req, res) => {
  const catalog = await loadCatalog();
  const customerId = Number(req.query.customer_id) || null;
  const cust = catalog.customers.find((c) => c.id === customerId);
  formPage(res, {
    title: 'New quote',
    catalog,
    order: {
      order_id: null,
      customer_id: customerId,
      fulfillment: cust ? cust.default_fulfillment : 'pickup',
      tax_rate: catalog.default_tax_rate,
      tax_exempt: cust ? cust.tax_exempt : false,
      auto_screws: true, closures: 'standard',
      framing: 'wood',
      contact_phone: cust?.phone || null,
      contact_email: cust?.email || null,
      sections: [{ area: 'roof', items: [] }, { area: 'wall', items: [] }, { area: 'trim', items: [] }],
    },
  });
});

router.get('/:id(\\d+)/edit', need('quotes'), async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  if (!EDITABLE.includes(order.status)) return res.redirect(`/orders/${order.order_id}`);
  // Colors since hidden from new orders still show on the lines that use them.
  const { rows: hidden } = await query(`
    SELECT color_id AS id, name, label, supplier_name AS supplier, finish, finish_label, upcharge_pct AS upcharge
    FROM v_colors WHERE NOT active
      AND color_id IN (SELECT color_id FROM order_items WHERE order_id = $1)`, [order.order_id]);
  order.hidden_colors = hidden;
  order.tax_exempt = order.tax_exempt_effective;
  formPage(res, { title: `Edit ${order.status === 'quote' ? 'quote' : 'order'} ${order.order_number}`, order, catalog: await loadCatalog() });
});

const saveHandler = (getId) => async (req, res) => {
  try {
    const id = await saveOrder(getId(req), req.body);
    res.json({ ok: true, redirect: `/orders/${id}` });
  } catch (err) {
    const msg = dbMessage(err);
    if (!msg) throw err;
    res.status(400).json({ ok: false, error: msg });
  }
};
router.post('/', need('quotes'), saveHandler(() => null));
router.post('/:id(\\d+)', need('quotes'), saveHandler((req) => Number(req.params.id)));

// Deleting: only quotes and cancelled orders (cancel first), and only ones nothing
// was cut, checked out or invoiced against. Real orders are cancelled, not deleted.
const DELETABLE = ['quote', 'cancelled'];
router.post('/:id(\\d+)/delete', need('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const fail = (msg) => res.redirect(`/orders/${id}?status_error=${encodeURIComponent(msg)}`);
  if (!typedDelete(req.body)) return fail('Not deleted: type DELETE to confirm.');
  const { rows: [o] } = await query('SELECT status, qbo_invoice_id FROM orders WHERE order_id = $1', [id]);
  if (!o) return res.status(404).send('Order not found');
  // An invoiced order (say, a test) can go once its QuickBooks invoice is deleted or voided there.
  if (o.status === 'invoiced') {
    const still = await qbo.invoiceStillOpen(o.qbo_invoice_id);
    if (still) return fail(`Delete or void invoice ${still} in QuickBooks first, then delete this order.`);
  } else if (!DELETABLE.includes(o.status)) return fail('Only quotes and cancelled orders can be deleted. Cancel it first.');
  const { rows: [open] } = await query('SELECT 1 FROM tool_rentals WHERE order_id = $1 AND returned_at IS NULL LIMIT 1', [id]);
  if (open) return fail('A rental tool on this order hasn\'t been returned yet.');
  try {
    await tx(async (db) => {
      // Supplies taken out for an invoiced order go back on the shelf first.
      if (o.status === 'invoiced') {
        await db.query("UPDATE orders SET status = 'cancelled', updated_by = $2 WHERE order_id = $1", [id, userName()]);
        await syncOrderSupplies(db, id, userName());
      }
      await db.query('DELETE FROM orders WHERE order_id = $1', [id]);
    });
  } catch (err) {
    if (err.code === '23503') return fail('Coil was already run for this order, so it can\'t be deleted (it would lose the coil history). Leave it cancelled.');
    throw err;
  }
  res.redirect('/orders');
});

router.post('/:id(\\d+)/status', async (req, res) => {
  const status = req.body.status;
  if (!SETTABLE.includes(status)) return res.status(400).send('Unknown status');
  const back = `/orders/${req.params.id}`;
  // An approved order needs a due date: it's what the shop board sorts by.
  const needBy = isoDate(req.body.need_by);
  const { rows: [cur] } = await query('SELECT status, need_by FROM orders WHERE order_id = $1', [req.params.id]);
  if (!cur) return res.status(404).send('Order not found');
  if (!allowedStatuses(cur.status).includes(status)) {
    return res.redirect(`${back}?status_error=${encodeURIComponent('Your account can\'t make that status change. Ask an Admin if you need it.')}`);
  }
  if (APPROVED.includes(status) && !cur.need_by && !needBy) {
    return res.redirect(`${back}?status_error=${encodeURIComponent('Set a Need-by date to approve this quote.')}`);
  }
  // Ready (or completed without going through Ready) needs a length check photo of every line.
  if (status === 'ready' || (status === 'completed' && !['ready', 'completed'].includes(cur.status))) {
    const missing = await proof.missingPhotos(Number(req.params.id));
    if (missing.length) return res.redirect(`${back}?status_error=${encodeURIComponent(proof.missingText(missing))}#photos`);
  }
  // Why a quote was lost, for the Reports page.
  const lostReason = cur.status === 'quote' && status === 'cancelled' && LOST_REASONS[req.body.lost_reason]
    ? req.body.lost_reason : null;
  await tx(async (db) => {
    await db.query(`
      UPDATE orders SET status = $1::order_status,
             need_by = COALESCE($3::date, need_by),
             lost_reason = $5,
             -- The order date is the day the quote was approved.
             ordered_on = CASE WHEN status = 'quote' AND $1::order_status <> ALL ('{quote,cancelled}'::order_status[])
                               THEN current_date ELSE ordered_on END,
             approved_by = CASE WHEN status = 'quote' AND $1::order_status <> ALL ('{quote,cancelled}'::order_status[])
                                THEN $4 ELSE approved_by END,
             updated_by = $4,
             -- Sent back to a quote to be redone: the customer answers it again.
             customer_decision = CASE WHEN $1::order_status = 'quote' AND status <> 'quote' THEN NULL ELSE customer_decision END,
             completed_at = CASE WHEN $1::order_status = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END,
             ready_at = CASE WHEN $1::order_status = 'ready' THEN COALESCE(ready_at, now())
                             WHEN $1::order_status IN ('quote', 'confirmed', 'in_production') THEN NULL
                             ELSE ready_at END
      WHERE order_id = $2 AND status <> 'invoiced'`, [status, req.params.id, needBy, userName(), lostReason]);
    // Boots, screws and other supplies come out of stock when the order is completed.
    await syncOrderSupplies(db, Number(req.params.id), userName());
  });
  // Completed orders become QuickBooks invoices.
  if (status === 'completed') qbo.orderCompleted(Number(req.params.id));
  if (status === 'ready' && cur.status !== 'ready') notices.orderReady(Number(req.params.id));
  res.redirect(back);
});

// What the customer said in the portal, and whether they can see this quote there.
const { DECLINE_REASONS } = require('./portal-shared');
function portalNote(o) {
  if (!o.customer_portal && !o.customer_decision) return '';
  const when = o.customer_decided_at && new Date(o.customer_decided_at).toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'medium', timeStyle: 'short' });
  const toggle = o.customer_portal && can('quotes') && o.status !== 'invoiced' ? html`
    <form method="post" action="/orders/${o.order_id}/portal" class="inline">
      <input type="hidden" name="hidden" value="${o.portal_hidden ? '0' : '1'}">
      <button class="btn small">${o.portal_hidden ? 'Show in customer portal' : 'Hide from customer portal'}</button></form>` : '';
  const said = o.customer_decision === 'approved'
    ? html`<div class="notice no-print"><strong>Customer approved this quote</strong> in the portal: ${o.customer_decided_by}, ${when}.
        ${o.customer_decision_note ? html`<br>“${o.customer_decision_note}”` : ''}
        ${o.status === 'quote' ? html`<br>Check it, then change the status to Confirmed to approve it for the shop.` : ''}</div>`
    : o.customer_decision === 'declined'
      ? html`<div class="alert no-print"><strong>Customer declined this quote</strong> in the portal: ${o.customer_decided_by}, ${when}
        (${DECLINE_REASONS[o.customer_decline_reason] || 'no reason'}).${o.customer_decision_note ? html`<br>“${o.customer_decision_note}”` : ''}
        <br>Edit it and they can answer again, or cancel it.</div>` : '';
  return html`${said}${toggle ? html`<p class="no-print muted small">${o.portal_hidden ? 'Hidden from the customer portal.' : 'The customer can see this in the portal.'} ${toggle}</p>` : ''}`;
}

router.post('/:id(\\d+)/portal', need('quotes'), async (req, res) => {
  await query('UPDATE orders SET portal_hidden = $2 WHERE order_id = $1', [req.params.id, req.body.hidden === '1']);
  res.redirect(`/orders/${req.params.id}`);
});

// Which statuses this person may move an order to from `from`.
//   Approving a quote: "approve". Moving an approved order along the shop steps:
//   "production". Anything else (cancel, reopen, back to quote): "status".
const SHOP_STEPS = ['in_production', 'ready', 'completed'];
function allowedStatuses(from) {
  return SETTABLE.filter((to) => {
    if (to === from) return false;
    if (can('status')) return true;
    if (from === 'quote') return APPROVED.includes(to) && can('approve');
    return APPROVED.includes(from) && SHOP_STEPS.includes(to) && can('production');
  });
}

// Width shown on a line: panel coverage, custom trim girth, or sized trim width.
const sizeCol = (i, { shop = true } = {}) => {
  if (i.pricing_unit === 'sqft' && i.width_in) {
    return `${num(i.width_in, 3)}" ${i.category === 'custom_trim' ? 'girth' : 'cov.'}`;
  }
  if (i.per_width_in && i.width_in) {
    return `${num(i.width_in, 3)}" wide${shop && i.product_flat_extra ? ` (${num(i.width_in + i.product_flat_extra, 3)}" flat)` : ''}`;
  }
  return '';
};

// Flat strip of coil one piece takes: panels use the product's girth (if any);
// trim uses the line's width plus how much wider the flat strip is (ridge cap +1").
const lineGirth = (i) => (i.category === 'panel' ? i.product_girth_in
  : i.width_in != null ? i.width_in + (i.product_flat_extra || 0) : i.product_girth_in);

// Subtotal, tax and total rows shared by the cut sheet and the customer copy.
const totalsRows = (o) => html`
  <tr><th>Subtotal</th><td>${money(o.pre_tax_total)}</td></tr>
  <tr><th>${o.tax_exempt_effective ? 'Sales tax (exempt)' : `Sales tax (${num(o.tax_rate, 3)}%)`}</th>
    <td>${money(o.tax_amount)}</td></tr>
  <tr class="grand"><th>Total</th><td>${money(o.grand_total)}</td></tr>
  ${o.deposit_amount ? html`<tr><th>Deposit received</th><td>−${money(o.deposit_amount)}</td></tr>
    <tr><th>Balance due</th><td>${money(o.grand_total - o.deposit_amount)}</td></tr>` : ''}`;

// The customer's copy of a quote or order. The portal can hide line prices
// (linePrices) or the order totals (totals) per customer.
function customerSheet(o, { linePrices = true, totals = true } = {}) {
  const isQuote = o.status === 'quote';
  const docName = isQuote ? 'Quote' : 'Order';
  const quoteDate = isQuote ? o.quoted_on : o.ordered_on;
  const sections = o.sections.filter((sec) => sec.items.length);
  return html`
    <section class="sheet customer-doc">
      <div class="sheet-head">
        <div class="sheet-brand"><img src="/logo.svg" alt="High Plains Custom Metal">
          805 E Fox Farm Rd Unit B · Cheyenne, WY 82007 · (307) 331-6449</div>
        <div class="sheet-no"><div class="doc-title">${docName.toUpperCase()}</div>
          <strong>${o.order_number}</strong><br>${date(quoteDate)}</div>
      </div>
      <dl class="sheet-fields">
        <dt>Customer</dt><dd>${o.customer_name}</dd>
        <dt>Job name</dt><dd>${o.job_name}</dd>
        <dt>Project / PO #</dt><dd>${o.po_number}</dd>
        <dt>${isQuote ? 'Valid until' : 'Need by'}</dt><dd>${date(isQuote ? o.valid_until : o.need_by)}</dd>
        <dt>Job address</dt><dd>${o.job_address_text}</dd>
        <dt>${o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}</dt><dd>${o.fulfillment === 'delivery' ? 'Delivered' : 'Customer pickup'}</dd>
      </dl>
      ${sections.map((sec) => html`
      <h3 class="area">${sec.is_auto ? (sec.label || 'Screws') : html`${AREA_LABEL[sec.area] || sec.area}${sec.label ? ` · ${sec.label}` : ''}`}</h3>
      <table class="lines">
        <thead><tr><th class="num">Qty</th><th>Length</th><th>Item</th><th>Color</th><th>Size</th>
          ${linePrices ? html`<th class="num">Price each</th><th class="num">Amount</th>` : ''}</tr></thead>
        <tbody>${sec.items.map((i) => html`
          <tr><td class="num">${num(i.pieces)}</td><td>${i.length_display}</td>
          <td>${i.product_name}${i.description ? html`<div class="muted small">${i.description}</div>` : ''}</td>
          <td>${i.customer_color}</td><td>${sizeCol(i, { shop: false })}</td>
          ${linePrices ? html`<td class="num">${money(i.pieces ? i.line_total / i.pieces : i.line_total)}</td>
          <td class="num">${money(i.line_total)}</td>` : ''}</tr>`)}</tbody>
      </table>`)}
      <div class="sheet-foot">
        <div>
          ${o.customer_memo ? html`<p><strong>Notes:</strong> ${o.customer_memo}</p>` : ''}
          ${isQuote ? html`<p class="muted small">Prices are good for 30 days. Lengths and quantities are
            cut exactly as listed, so please check them before approving.</p>` : ''}
        </div>
        ${totals ? html`<table class="totals">
          <tr><th>Materials</th><td>${money(o.lines_subtotal)}</td></tr>
          ${o.delivery_charge ? html`<tr><th>Delivery</th><td>${money(o.delivery_charge)}</td></tr>` : ''}
          ${o.discount_amount ? html`<tr><th>Discount</th><td>−${money(o.discount_amount)}</td></tr>` : ''}
          ${totalsRows(o)}
        </table>` : ''}
      </div>
    </section>`;
}

// What the customer sees: one price per piece (the line amount over the pieces),
// no billing units, no coil supplier. Print it, or save it as a PDF to email.
router.get('/:id(\\d+)/customer', need('prices'), async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o) return res.status(404).send('Order not found');
  const isQuote = o.status === 'quote';
  const docName = isQuote ? 'Quote' : 'Order';
  const email = o.contact_email || o.customer_email;
  const subject = `${docName} ${o.order_number} from High Plains Custom Metal`;
  const body = [
    'Hello,', '',
    `Attached is ${docName.toLowerCase()} ${o.order_number}${o.job_name ? ` for ${o.job_name}` : ''}.`,
    `Total: ${money(o.grand_total)}${o.tax_amount ? ' including sales tax' : ''}.`,
    ...(isQuote ? [`Prices are good until ${date(o.valid_until)}.`] : []),
    '', 'Thank you,', 'High Plains Custom Metal', '(307) 331-6449',
  ].join('\n');
  // Gmail's compose page, filled in; the PDF still has to be attached by hand.
  const gmail = `https://mail.google.com/mail/?${new URLSearchParams({
    view: 'cm', fs: '1', to: email || '', su: subject, body })}`;
  res.send(layout({
    title: `${docName} ${o.order_number} (customer)`, active: '/orders',
    body: html`
    <div class="page-head no-print">
      <h1>Customer ${docName.toLowerCase()} ${o.order_number}</h1>
      <div class="actions">
        <a class="btn" href="/orders/${o.order_id}">Back</a>
        <button class="btn primary" onclick="window.print()">Print or save as PDF</button>
        <a class="btn" href="${gmail}" target="_blank" rel="noopener">Email with Gmail</a>
      </div>
    </div>
    <p class="muted small no-print">To email it: click <strong>Print or save as PDF</strong> and save the PDF, then click
      <strong>Email with Gmail</strong>. Gmail opens with the ${email ? `customer's address (${email}),` : 'subject and'} message
      filled in; attach the PDF and send. ${email ? '' : 'Add an email address to the customer or order to fill in the To line.'}
      ${email ? html`Not using Gmail? <a href="mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}">Use your email app</a>.` : ''}</p>
    ${customerSheet(o)}`,
  }));
});

router.get('/:id(\\d+)', async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o) return res.status(404).send('Order not found');
  const editable = EDITABLE.includes(o.status);

  const sectionTotals = (items) => {
    const sq = items.filter((i) => i.pricing_unit === 'sqft').reduce((a, i) => a + i.billable_qty, 0);
    const lf = items.filter((i) => i.pricing_unit === 'lf').reduce((a, i) => a + i.billable_qty, 0);
    return [sq ? `${num(sq)} sq ft` : '', lf ? `${num(lf)} LF` : ''].filter(Boolean).join(' · ');
  };
  const nextStatuses = allowedStatuses(o.status);
  const prices = can('prices');
  // Each-priced pieces cut to a length are billed in standard lengths: "7.2 × 10'".
  // Sized trim adds the standard width: "18.46 × 13" × 10'".
  const billed = (i) => {
    if (i.is_rental) return `${num(i.billable_qty)} day${Number(i.billable_qty) === 1 ? '' : 's'}`;
    if (i.pricing_unit !== 'each') return `${num(i.billable_qty)} ${UNIT_LABEL[i.pricing_unit]}`;
    const parts = [i.per_width_in && i.width_in ? `${num(i.per_width_in, 3)}"` : '',
      i.per_length_in && (i.length_in || (i.per_width_in && i.width_in)) ? `${num(i.per_length_in / 12)}'` : ''].filter(Boolean);
    return parts.length ? `${num(i.billable_qty)} × ${parts.join(' × ')}` : `${num(i.billable_qty)} ${UNIT_LABEL.each}`;
  };
  const production = await productionSection(o, req);
  const rentals = await rentalsSection(o, req);
  const docName = o.status === 'quote' ? 'Quote' : 'Order';

  res.send(layout({
    title: `Order ${o.order_number}`, active: '/orders',
    body: html`
    <div class="page-head no-print">
      <h1>${docName} ${o.order_number} ${statusBadge(o.status)}${o.lost_reason ? html` <span class="muted small">Lost: ${LOST_REASONS[o.lost_reason]}</span>` : ''}</h1>
      <div class="actions">
        ${editable && can('quotes') ? html`<a class="btn primary" href="/orders/${o.order_id}/edit">Edit ${docName.toLowerCase()}</a>` : ''}
        ${prices ? html`<a class="btn" href="/orders/${o.order_id}/customer">Customer ${o.status === 'quote' ? 'quote' : 'copy'}</a>` : ''}
        <button class="btn" onclick="window.print()">Print cut sheet</button>
        ${o.status !== 'quote' && o.status !== 'cancelled' ? html`<a class="btn" href="/labels/order/${o.order_id}">Labels</a>` : ''}
        ${['confirmed', 'in_production', 'ready'].includes(o.status) && can('production') ? html`<a class="btn" href="/orders/${o.order_id}/pack">Pack &amp; check</a>` : ''}
        ${o.status === 'ready' && (can('production') || can('quotes')) ? html`<a class="btn primary" href="/orders/${o.order_id}/handoff">${o.fulfillment === 'delivery' ? 'Delivered…' : 'Picked up…'}</a>` : ''}
        ${(DELETABLE.includes(o.status) || o.status === 'invoiced') && isAdmin() ? deleteButton(`/orders/${o.order_id}/delete`, `${docName.toLowerCase()} ${o.order_number}`) : ''}
        ${o.status !== 'invoiced' && nextStatuses.length ? html`
        <form method="post" action="/orders/${o.order_id}/status" class="inline">
          <select name="status">${nextStatuses.map((s) => html`<option value="${s}">${STATUS_LABEL[s]}</option>`)}</select>
          ${o.need_by || o.status !== 'quote' ? '' : html`<label class="inline-date" title="Needed to approve a quote">Need by
            <input type="date" name="need_by"></label>`}
          ${o.status === 'quote' && nextStatuses.includes('cancelled') ? html`<label class="inline-date lost-reason" hidden>Why lost
            <select name="lost_reason"><option value="">Pick one…</option>${Object.entries(LOST_REASONS).map(([v, l]) =>
              html`<option value="${v}">${l}</option>`)}</select></label>
            <script>(() => { const f = document.currentScript.closest('form'), r = f.querySelector('.lost-reason');
              const sync = () => { r.hidden = f.status.value !== 'cancelled'; }; f.status.addEventListener('change', sync); sync(); })();</script>` : ''}
          <button class="btn">Change status</button>
        </form>` : ''}
      </div>
    </div>
    ${req.query.status_error ? html`<div class="alert no-print">${req.query.status_error}</div>` : ''}
    ${portalNote(o)}
    ${o.from_portal ? html`<p class="no-print muted small">The customer wrote this quote in the portal, at price list prices.</p>` : ''}

    <section class="sheet">
      <div class="sheet-head">
        <div class="sheet-brand"><img src="/logo.svg" alt="High Plains Custom Metal">
          805 E Fox Farm Rd Unit B · Cheyenne, WY 82007 · (307) 331-6449</div>
        <div class="sheet-no">${docName} <strong>${o.order_number}</strong><br>${STATUS_LABEL[o.status]}</div>
      </div>
      <dl class="sheet-fields">
        <dt>Contractor / Customer</dt><dd><a href="/customers/${o.customer_id}">${o.customer_name}</a></dd>
        <dt>Job name</dt><dd>${o.job_name}</dd>
        <dt>Project / PO #</dt><dd>${o.po_number}</dd>
        <dt>Need by</dt><dd>${date(o.need_by)}</dd>
        <dt>Job address</dt><dd>${o.job_address_text}</dd>
        <dt>${o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}</dt><dd>${o.status === 'quote'
          ? `Quoted ${date(o.quoted_on)}` : `Ordered ${date(o.ordered_on)}`}</dd>
        <dt>Phone</dt><dd>${o.contact_phone || o.customer_phone}</dd>
        <dt>Email</dt><dd>${o.contact_email || o.customer_email}</dd>
      </dl>

      ${o.sections.map((s) => html`
      <h3 class="area">${s.is_auto ? (s.label || 'Screws') : html`${AREA_LABEL[s.area]}${s.label ? `: ${s.label}` : ''}`}
        <span class="area-total">${sectionTotals(s.items)}</span></h3>
      <table class="lines">
        <thead><tr><th class="num">Qty</th><th>Length</th><th>Panel / profile</th><th>Gauge</th><th>Color</th>
          <th>Width</th>${prices ? html`<th class="num">Billed</th><th class="num">Price</th><th class="num">Amount</th>` : ''}</tr></thead>
        <tbody>${s.items.length ? s.items.map((i) => html`
          <tr><td class="num">${num(i.pieces)}</td><td>${i.length_display}</td>
          <td>${i.product_name}${i.description ? html`<div class="muted small">${i.description}</div>` : ''}
            ${i.attachments.map((a) => html`<div class="small"><a href="#drawing-${a.attachment_id}">📎 Drawing: ${a.filename}</a></div>`)}</td>
          <td>${i.gauge || ''}</td><td>${i.color_name}</td><td>${sizeCol(i)}</td>
          ${prices ? html`<td class="num">${billed(i)}</td>
          <td class="num">${money(i.unit_price)}</td><td class="num">${money(i.line_total)}</td>` : ''}</tr>`)
        : html`<tr><td colspan="9" class="empty">Nothing in this section.</td></tr>`}</tbody>
      </table>`)}

      <div class="sheet-foot">
        <div>
          ${o.customer_memo ? html`<p><strong>Note to customer:</strong> ${o.customer_memo}</p>` : ''}
          ${o.internal_notes ? html`<p class="no-print"><strong>Shop notes:</strong> ${o.internal_notes}</p>` : ''}
          ${o.handed_off_at ? html`<p><strong>${o.handoff_method === 'delivery' ? 'Delivered' : 'Picked up'}</strong>
            ${new Date(o.handed_off_at).toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'medium', timeStyle: 'short' })}${
            o.received_by ? `, received by ${o.received_by}` : ''}${o.handed_off_by ? ` (handed off by ${o.handed_off_by})` : ''}${
            o.handoff_note ? html`<br><span class="muted">${o.handoff_note}</span>` : ''}</p>` : ''}
          ${o.created_by || o.approved_by ? html`<p class="no-print muted small">${o.created_by ? `Written by ${o.created_by}` : ''}${
            o.created_by && o.approved_by ? ' · ' : ''}${o.approved_by ? `approved by ${o.approved_by}` : ''}${
            o.updated_by && o.updated_by !== o.created_by ? ` · last changed by ${o.updated_by}` : ''}</p>` : ''}
          <table class="shop-use">
            <tr><th>Completed by</th><td>${o.completed_by}</td><th>Inspected by</th><td>${o.inspected_by}</td></tr>
            <tr><th>Invoice #</th><td>${o.qbo_doc_number}</td><th>Date</th><td>${date(o.completed_at)}</td></tr>
          </table>
          ${await qboLine(o)}
        </div>
        ${prices ? html`<table class="totals">
          <tr><th>Materials</th><td>${money(o.lines_subtotal)}</td></tr>
          ${o.delivery_charge ? html`<tr><th>Delivery</th><td>${money(o.delivery_charge)}</td></tr>` : ''}
          ${o.discount_amount ? html`<tr><th>Discount</th><td>−${money(o.discount_amount)}</td></tr>` : ''}
          ${totalsRows(o)}
        </table>` : ''}
      </div>
    </section>
    ${photosSection(o)}
    ${drawingsSection(o)}
    ${rentals}
    ${production}`,
    scripts: ['/production.js', '/attachments.js', '/photos.js'],
  }));
});

// ---------------------------------------------------------------------------
// Length check photos: a tape measure on each line's pieces, taken before the
// order is marked ready. The customer sees them in the portal.
// ---------------------------------------------------------------------------
const ATTACH_TYPES = {
  'application/pdf': 'pdf', 'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image', 'image/webp': 'image',
};
const ATTACH_MAX = 20 * 1024 * 1024;
const isImage = (a) => ATTACH_TYPES[a.content_type] === 'image';
const fileSize = (n) => (n >= 1024 * 1024 ? `${num(n / 1024 / 1024, 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const PHOTO_STATUSES = ['confirmed', 'in_production', 'ready', 'completed'];
const canPhoto = () => can('production') || can('drawings');

function photosSection(o) {
  if (!PHOTO_STATUSES.includes(o.status) && !o.photos.length) return '';
  const lines = o.sections.flatMap((sec) => sec.items).filter((i) => !['service', 'delivery'].includes(i.category) && !i.is_rental);
  if (!lines.length) return '';
  const add = PHOTO_STATUSES.includes(o.status) && canPhoto();
  const missing = lines.filter((i) => !i.photos.length).length;
  return html`
  <section id="photos" class="photos no-print">
    <h2>Length check photos</h2>
    <p class="muted small">Before it's marked ready, each line gets a photo of its pieces with a tape measure showing the length.
      ${missing ? html`<strong>${missing} of ${lines.length} line${lines.length === 1 ? '' : 's'} still need${missing === 1 ? 's' : ''} one.</strong>` : 'Every line has one.'}
      ${o.customer_portal ? 'The customer sees these in the portal.' : ''}</p>
    <table class="list photo-lines">
      <thead><tr><th>Line</th><th>Pieces</th><th>Photos</th></tr></thead>
      <tbody>${lines.map((i) => html`<tr class="${i.photos.length ? '' : 'needs-photo'}">
        <td>${i.line_no}</td>
        <td>${num(i.pieces)}${i.length_display ? html` × <strong>${i.length_display}</strong>` : ''} ${i.product_name}${i.color_name ? html`<div class="muted small">${i.color_name}</div>` : ''}</td>
        <td>${proof.photoCell({ orderId: o.order_id, lineId: i.order_item_id, photos: i.photos, canAdd: add, base: `/orders/${o.order_id}/attachments` })}
          ${add ? i.photos.map((ph) => html`<form method="post" action="/orders/${o.order_id}/attachments/${ph.attachment_id}/delete" class="inline photo-remove"
            onsubmit="return confirm('Remove this photo?')"><button class="linkish small">remove</button></form>`) : ''}</td></tr>`)}</tbody>
    </table>
  </section>`;
}

router.post('/:id(\\d+)/photos', express.raw({ type: () => true, limit: ATTACH_MAX }), async (req, res) => {
  if (!canPhoto()) return res.status(403).json({ error: 'Your account can\'t add photos.' });
  const orderId = Number(req.params.id);
  const type = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ATTACH_TYPES[type] !== 'image') return res.status(400).json({ error: 'That isn\'t a photo.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'The photo is empty.' });
  const { rows: [line] } = await query(`SELECT o.status FROM order_items oi JOIN orders o USING (order_id)
    WHERE oi.order_item_id = $1 AND oi.order_id = $2`, [Number(req.query.line) || 0, orderId]);
  if (!line) return res.status(400).json({ error: 'That line isn\'t on this order.' });
  if (!PHOTO_STATUSES.includes(line.status)) return res.status(400).json({ error: 'Photos are for approved orders.' });
  let filename = 'photo.jpg';
  try { filename = decodeURIComponent(req.get('x-filename') || '') || filename; } catch { /* keep default */ }
  const { rows: [a] } = await query(`
    INSERT INTO order_attachments (order_id, order_item_id, filename, content_type, byte_size, data, uploaded_by, is_proof)
    VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING attachment_id`,
  [orderId, Number(req.query.line), filename.slice(0, 200), type, req.body.length, req.body, userName()]);
  res.json({ ok: true, attachment_id: a.attachment_id });
});

// ---------------------------------------------------------------------------
// Drawings: files attached to the order or to one line (reMarkable exports,
// photos, PDFs). Pictures print on the cut sheet; PDFs open in a new tab.
// ---------------------------------------------------------------------------

function drawingsSection(o) {
  const items = o.sections.flatMap((s) => s.items);
  const lineLabel = (a) => (a.order_item_id ? `Line ${a.line_no}: ${a.product_name}` : 'Whole order');
  const canEdit = o.status !== 'invoiced' && can('drawings');
  if (!o.attachments.length && !canEdit) return '';
  return html`
  <section id="drawings" class="drawings${o.attachments.length ? '' : ' no-print'}">
    <h2>Drawings &amp; files</h2>
    ${o.attachments.length ? '' : html`<p class="muted no-print">No drawings yet. Export the page from the reMarkable
      (Share, then PDF or PNG) and attach it here. Pictures (PNG or JPG) also print with the cut sheet.</p>`}
    ${o.attachments.map((a) => {
    const url = `/orders/${o.order_id}/attachments/${a.attachment_id}`;
    return html`
    <div class="drawing" id="drawing-${a.attachment_id}">
      <div class="drawing-head">
        <strong>${lineLabel(a)}</strong>
        <span class="muted small">${a.filename} · ${fileSize(a.byte_size)}${a.uploaded_by ? ` · added by ${a.uploaded_by}` : ''}${a.from_customer ? ' (customer)' : ''}</span>
        ${a.note ? html`<span>${a.note}</span>` : ''}
        <span class="actions no-print">
          <a class="btn small" href="${url}" target="_blank" rel="noopener">Open full size</a>
          ${canEdit ? html`<form method="post" action="${url}/delete" class="inline"
            onsubmit="return confirm('Remove this drawing?')"><button class="btn small">Remove</button></form>` : ''}
        </span>
      </div>
      ${isImage(a) ? html`<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${a.filename}"></a>`
    : html`<object class="no-print" data="${url}" type="application/pdf"><a href="${url}" target="_blank">Open ${a.filename}</a></object>
      <p class="print-only small">PDF drawing: open it in the CRM to view or print.</p>`}
    </div>`;
  })}
    ${canEdit ? html`
    <form class="card attach-form no-print" data-action="/orders/${o.order_id}/attachments">
      <label>File (PDF, PNG or JPG)<input type="file" name="file" accept="application/pdf,image/png,image/jpeg,image/gif,image/webp" required></label>
      <label>For<select name="line">
        <option value="">Whole order</option>
        ${items.map((i) => html`<option value="${i.order_item_id}">
          Line ${i.line_no}: ${num(i.pieces)} × ${i.length_display || 'each'} ${i.product_name}</option>`)}
      </select></label>
      <label>Note<input name="note" placeholder="optional, e.g. bend order"></label>
      <button class="btn primary">Attach</button>
      <span class="attach-status muted small"></span>
    </form>` : ''}
  </section>`;
}

router.post('/:id(\\d+)/attachments', need('drawings'), express.raw({ type: () => true, limit: ATTACH_MAX }), async (req, res) => {
  const orderId = Number(req.params.id);
  const type = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ATTACH_TYPES[type]) return res.status(400).json({ error: 'Attach a PDF or a picture (PNG or JPG).' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'The file is empty.' });
  let filename = 'drawing';
  try { filename = decodeURIComponent(req.get('x-filename') || '') || filename; } catch { /* keep default */ }
  const lineId = req.query.line ? Number(req.query.line) : null;
  const { rows: [o] } = await query('SELECT status FROM orders WHERE order_id = $1', [orderId]);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status === 'invoiced') return res.status(400).json({ error: 'This order is already invoiced.' });
  if (lineId) {
    const { rows } = await query('SELECT 1 FROM order_items WHERE order_item_id = $1 AND order_id = $2', [lineId, orderId]);
    if (!rows.length) return res.status(400).json({ error: 'That line isn\'t on this order.' });
  }
  const { rows: [a] } = await query(`
    INSERT INTO order_attachments (order_id, order_item_id, filename, content_type, byte_size, data, note, uploaded_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING attachment_id`,
  [orderId, lineId, filename.slice(0, 200), type, req.body.length, req.body, (req.query.note || '').trim() || null, userName()]);
  res.json({ ok: true, attachment_id: a.attachment_id });
});

router.get('/:id(\\d+)/attachments/:aid(\\d+)', async (req, res) => {
  const { rows: [a] } = await query(
    'SELECT filename, content_type, data FROM order_attachments WHERE attachment_id = $1 AND order_id = $2',
    [req.params.aid, req.params.id]);
  if (!a) return res.status(404).send('File not found');
  res.set({
    'Content-Type': a.content_type,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
  });
  res.send(a.data);
});

router.post('/:id(\\d+)/attachments/:aid(\\d+)/delete', need('drawings', 'production'), async (req, res) => {
  // Production can remove length check photos; drawings need the drawings permission.
  const { rows: [a] } = await query(`DELETE FROM order_attachments a USING orders o
    WHERE a.attachment_id = $1 AND a.order_id = $2 AND o.order_id = a.order_id AND o.status <> 'invoiced'
      AND (a.is_proof OR $3) RETURNING a.is_proof`,
  [req.params.aid, req.params.id, can('drawings')]);
  res.redirect(`/orders/${req.params.id}#${a && a.is_proof ? 'photos' : 'drawings'}`);
});

// ---------------------------------------------------------------------------
// Tool rentals: each rental line on an approved order is one tool, checked out
// when the customer picks it up and back in when it's returned.
// ---------------------------------------------------------------------------
const canRent = () => can('inventory') || can('quotes');

// Where a completed order stands with QuickBooks, with a button to send it again.
async function qboLine(o) {
  if (!['completed', 'invoiced'].includes(o.status) || !can('prices') || !(await qbo.connected())) return '';
  const retry = can('approve') || can('status') ? html` <form method="post" action="/orders/${o.order_id}/qbo" class="inline">
    <button class="btn small">${o.qbo_invoice_id ? 'Send again' : 'Send to QuickBooks'}</button></form>` : '';
  if (o.qbo_sync_status === 'error') return html`<p class="no-print"><span class="warn-text">Not in QuickBooks: ${o.qbo_last_error}</span>${retry}</p>`;
  if (o.qbo_invoice_id) return html`<p class="no-print muted small">In QuickBooks as invoice ${o.qbo_doc_number}${retry}</p>`;
  if (o.qbo_sync_status === 'pending') return html`<p class="no-print muted small">Sending to QuickBooks…</p>`;
  return html`<p class="no-print muted small">Not in QuickBooks yet${retry}</p>`;
}

async function rentalsSection(o, req) {
  const lines = o.sections.flatMap((s) => s.items).filter((i) => i.is_rental);
  const { rows: rentals } = await query(`
    SELECT r.*, t.name AS tool_name, t.tag,
           (COALESCE(r.returned_at, now()) AT TIME ZONE 'America/Denver')::date
             - (r.out_at AT TIME ZONE 'America/Denver')::date AS days,
           r.returned_at IS NULL AND r.due_back < (now() AT TIME ZONE 'America/Denver')::date AS overdue
    FROM tool_rentals r JOIN tools t USING (tool_id) WHERE r.order_id = $1 ORDER BY r.out_at`, [o.order_id]);
  if (!lines.length && !rentals.length) return '';
  const open = !NO_PRODUCTION.includes(o.status) && o.status !== 'invoiced' && canRent();
  const { rows: tools } = open ? await query(`
    SELECT t.tool_id, t.name, t.tag, t.rental_product_id FROM tools t
    WHERE t.status = 'available' AND t.rental_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM tool_rentals r WHERE r.tool_id = t.tool_id AND r.returned_at IS NULL)
    ORDER BY t.name, t.tag`) : { rows: [] };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const rentalRow = (r, line) => {
    const days = Math.max(1, r.days);
    return html`<tr>
      <td>${line ? line.line_no : ''}</td>
      <td><a href="/tools/${r.tool_id}">${r.tool_name}</a>${r.tag ? html` <span class="muted">#${r.tag}</span>` : ''}</td>
      <td>${date(r.out_at)}${r.out_by ? html` <span class="muted small">${r.out_by}</span>` : ''}</td>
      <td>${date(r.due_back)}${r.overdue ? html` <span class="badge badge-cancelled">overdue</span>` : ''}</td>
      <td>${r.returned_at ? html`${date(r.returned_at)}${r.returned_by ? html` <span class="muted small">${r.returned_by}</span>` : ''}${
        r.return_note ? html`<div class="muted small">${r.return_note}</div>` : ''}` : html`<strong>Out</strong>`}</td>
      <td class="num">${days}${line && days > Number(line.pieces) ? html` <span class="badge badge-cancelled" title="Days billed on the order">billed ${num(line.pieces)}</span>` : ''}</td>
      <td class="num">${!r.returned_at && open ? html`<form method="post" action="/orders/${o.order_id}/rentals/${r.rental_id}/return" class="inline">
        <input name="note" placeholder="Condition / note" style="width:10rem">
        <button class="btn small primary">Returned</button></form>` : ''}</td></tr>`;
  };
  return html`
  <section class="no-print" id="rentals">
    <h2>Tool rentals</h2>
    ${req.query.rental_error ? html`<div class="alert">${req.query.rental_error}</div>` : ''}
    <table class="list">
      <thead><tr><th>Line</th><th>Tool</th><th>Picked up</th><th>Due back</th><th>Returned</th><th class="num">Days out</th><th></th></tr></thead>
      <tbody>
      ${lines.map((l) => {
        const mine = rentals.filter((r) => r.order_item_id === l.order_item_id);
        const out = mine.some((r) => !r.returned_at);
        const choices = tools.filter((t) => t.rental_product_id === l.product_id);
        return html`${mine.map((r) => rentalRow(r, l))}
        ${!out && !mine.length ? html`<tr><td>${l.line_no}</td><td colspan="5">${l.product_name}, ${num(l.pieces)} day${Number(l.pieces) === 1 ? '' : 's'}
          ${o.status === 'quote' ? html`<span class="muted">· approve the quote to check it out</span>`
          : open ? (choices.length ? html`<form method="post" action="/orders/${o.order_id}/rentals" class="inline rental-out">
              <input type="hidden" name="order_item_id" value="${l.order_item_id}">
              <select name="tool_id" required>${choices.map((t) => html`<option value="${t.tool_id}">${t.name}${t.tag ? ` #${t.tag}` : ''}</option>`)}</select>
              <label class="inline-date">Due back <input type="date" name="due_back" value="${addDays(today, Math.max(1, Math.ceil(Number(l.pieces))))}"></label>
              <button class="btn small primary">Picked up</button></form>`
            : html`<span class="muted">· no ${l.product_name.replace(/\s*\(per day\)/i, '')} is in the shop right now (see <a href="/tools">Tools</a>)</span>`) : ''}
          </td><td></td></tr>` : ''}`;
      })}
      ${rentals.filter((r) => !lines.some((l) => l.order_item_id === r.order_item_id)).map((r) => rentalRow(r, null))}
      </tbody>
    </table>
  </section>`;
}

router.post('/:id(\\d+)/rentals', async (req, res) => {
  if (!canRent()) return res.status(403).send('Not allowed');
  const back = (err) => res.redirect(`/orders/${req.params.id}${err ? `?rental_error=${encodeURIComponent(err)}` : ''}#rentals`);
  const { rows: [line] } = await query(`
    SELECT oi.order_item_id, oi.product_id, o.status FROM order_items oi JOIN orders o USING (order_id)
    JOIN products p ON p.product_id = oi.product_id
    WHERE oi.order_item_id = $1 AND oi.order_id = $2 AND p.is_rental`, [Number(req.body.order_item_id) || null, req.params.id]);
  if (!line) return back('That rental isn\'t on this order.');
  if (NO_PRODUCTION.includes(line.status) || line.status === 'invoiced') return back('Approve the quote before checking tools out.');
  const { rows: [tool] } = await query('SELECT tool_id FROM tools WHERE tool_id = $1 AND rental_product_id = $2 AND status = \'available\'',
    [Number(req.body.tool_id) || null, line.product_id]);
  if (!tool) return back('Pick a tool that matches the rental line.');
  const due = /^\d{4}-\d{2}-\d{2}$/.test(req.body.due_back || '') ? req.body.due_back : null;
  try {
    await query(`INSERT INTO tool_rentals (tool_id, order_id, order_item_id, due_back, out_by) VALUES ($1, $2, $3, $4, $5)`,
      [tool.tool_id, req.params.id, line.order_item_id, due, userName()]);
  } catch (err) {
    if (err.code !== '23505') throw err;
    return back('That tool is already out. Pick another one.');
  }
  back();
});

router.post('/:id(\\d+)/rentals/:rid(\\d+)/return', async (req, res) => {
  if (!canRent()) return res.status(403).send('Not allowed');
  await query(`UPDATE tool_rentals SET returned_at = now(), returned_by = $3, return_note = $4
    WHERE rental_id = $1 AND order_id = $2 AND returned_at IS NULL`,
  [req.params.rid, req.params.id, userName(), (req.body.note || '').trim() || null]);
  res.redirect(`/orders/${req.params.id}#rentals`);
});

// ---------------------------------------------------------------------------
// Production: which coils each line was run from
// ---------------------------------------------------------------------------
const NO_PRODUCTION = ['quote', 'cancelled'];

async function productionSection(o, req) {
  const items = o.sections.flatMap((s) => s.items.map((i) => ({ ...i, area: s.area })))
    .filter((i) => RUNNABLE.includes(i.category));
  if (!items.length) return '';
  const { rows: runs } = await query(`
    SELECT r.*, fn_format_length(r.length_in) AS length_display, oi.line_no, oi.color_id AS line_color_id,
           c.coil_tag, c.color_id AS coil_color_id, c.color_label AS coil_color, c.gauge AS coil_gauge
    FROM production_runs r
    JOIN order_items oi USING (order_item_id)
    JOIN v_coils c USING (coil_id)
    WHERE oi.order_id = $1 ORDER BY r.run_at, r.production_run_id`, [o.order_id]);
  const runPieces = (id) => runs.filter((r) => r.order_item_id === id).reduce((a, r) => a + r.pieces, 0);
  const canLog = !NO_PRODUCTION.includes(o.status) && o.status !== 'invoiced' && can('production');
  const { rows: coils } = canLog ? await query(`
    SELECT coil_id, coil_tag, color_id, color_label, gauge_id, gauge, width_in, current_lf
    FROM v_coils WHERE status IN ('received','in_stock','on_machine')
    ORDER BY color_label, gauge, coil_tag`) : { rows: [] };
  const back = `/orders/${o.order_id}`;
  return html`
  <section class="no-print" id="production">
    <h2>Production</h2>
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    <table class="list">
      <thead><tr><th>Line</th><th>Run</th><th>Coil</th><th class="num">Used</th><th>By</th><th>When</th><th></th></tr></thead>
      <tbody>${runs.length ? runs.map((r) => html`<tr>
        <td>${r.line_no}</td><td>${r.pieces} × ${r.length_display}</td>
        <td><a href="/coils/${r.coil_id}">${r.coil_tag}</a> ${r.coil_color}
          ${r.coil_color_id !== r.line_color_id ? html`<span class="badge badge-cancelled">different color</span>` : ''}</td>
        <td class="num">${num(r.lf_used, 1)} LF${r.scrap_lf ? html` <span class="muted small">(${num(r.scrap_lf, 1)} scrap)</span>` : ''}</td>
        <td>${r.operator}</td><td>${date(r.run_at)}</td>
        <td class="num">${canLog ? html`<form method="post" action="/runs/${r.production_run_id}/undo" class="inline"
            onsubmit="return confirm('Undo this run? The footage goes back on the coil.')">
            <input type="hidden" name="back" value="${back}"><button class="btn small">Undo</button></form>` : ''}</td></tr>`)
      : html`<tr><td colspan="7" class="empty">Nothing has been run for this order yet.</td></tr>`}</tbody>
    </table>
    ${o.status === 'quote' ? html`<p class="muted">Confirm the order to start logging production.</p>` : ''}
    ${canLog ? html`
    <form method="post" action="/orders/${o.order_id}/runs" class="card form-grid run-form" style="margin-top:1rem">
      <label class="span2">Line *<select name="order_item_id" required>
        <option value="">Pick a line…</option>
        ${items.map((i) => html`<option value="${i.order_item_id}" data-pieces="${Math.max(0, i.pieces - runPieces(i.order_item_id))}"
            data-length="${i.length_in ?? i.per_length_in ?? ''}" data-girth="${lineGirth(i) ?? ''}" data-color="${i.color_id ?? ''}" data-gauge="${i.product_gauge_id ?? ''}"
>
          ${i.line_no}. ${AREA_LABEL[i.area]}: ${num(i.pieces)} × ${i.length_display || 'each'} ${i.product_name}${i.color_name ? `, ${i.color_name}` : ''}
          (${runPieces(i.order_item_id)} of ${num(i.pieces)} run)</option>`)}
      </select></label>
      <label class="span2">Coil *<select name="coil_id" required>
        <option value="">Pick a coil…</option>
        ${coils.map((c) => html`<option value="${c.coil_id}" data-color="${c.color_id}" data-gauge="${c.gauge_id}" data-width="${c.width_in}">
          ${c.coil_tag}: ${c.color_label}, ${c.gauge} ga, ${num(c.width_in, 3)}" (${num(c.current_lf, 0)} LF left)</option>`)}
      </select></label>
      <div class="span2 alert run-warning" hidden></div>
      <label>Pieces *<input name="pieces" type="number" min="1" step="1" required></label>
      <label>Length<span class="row"><input name="ft" inputmode="numeric" placeholder="ft"><span class="unit">'</span>
        <input name="inch" placeholder="in"><span class="unit">"</span></span></label>
      <label>Coil feet used<input name="lf_used" type="number" step="0.1" min="0"></label>
      <label>Of that, scrap (LF)<input name="scrap_lf" type="number" step="0.1" min="0" placeholder="0"></label>
      <label>By<input name="operator" value="${userName()}"></label>
      <label class="check run-confirm" hidden><input type="checkbox" name="confirm" value="1"> Use this coil anyway</label>
      <div class="span2 actions"><button class="btn primary">Log run</button></div>
      <p class="span2 muted small"><span class="run-across"></span> Coil feet used fills in as pieces × length
        (for trim with a flat width set, pieces that fit side by side across the coil share the same footage). Change it if more came off the coil,
        and put any wasted footage under scrap.</p>
    </form>` : ''}
  </section>`;
}

router.post('/:id(\\d+)/runs', need('production'), async (req, res) => {
  const orderId = Number(req.params.id);
  const b = req.body;
  const back = (msg) => res.redirect(`/orders/${orderId}?error=${encodeURIComponent(msg)}#production`);
  const { rows: [line] } = await query(`
    SELECT oi.*, p.category, p.gauge_id AS product_gauge_id, p.girth_in AS product_girth_in,
           p.flat_extra_in AS product_flat_extra, o.status, col.label AS color_label
    FROM order_items oi JOIN products p USING (product_id) JOIN orders o USING (order_id)
    LEFT JOIN v_colors col ON col.color_id = oi.color_id
    WHERE oi.order_item_id = $1 AND oi.order_id = $2`, [Number(b.order_item_id), orderId]);
  if (!line) return back('Pick a line.');
  if (NO_PRODUCTION.includes(line.status) || line.status === 'invoiced') return back('Production can\'t be logged on this order.');
  const { rows: [coil] } = await query('SELECT * FROM v_coils WHERE coil_id = $1', [Number(b.coil_id)]);
  if (!coil) return back('Pick a coil.');
  const pieces = Number(b.pieces);
  if (!(pieces > 0) || !Number.isInteger(pieces)) return back('Enter a whole number of pieces.');
  let len = feetInches(b.ft, b.inch);
  if (Number.isNaN(len)) return back('The length isn\'t readable. Use feet, then inches like 6 or 6 1/2.');
  len = len || line.length_in;
  if (!(len > 0)) return back('Enter the length that was cut.');

  // The same color name from another supplier, or another gauge, doesn't match.
  const problems = [];
  if (line.color_id && coil.color_id !== line.color_id) {
    problems.push(`the coil is ${coil.color_label} but the line is ${line.color_label}`);
  }
  if (line.product_gauge_id && coil.gauge_id !== line.product_gauge_id) {
    problems.push(`the coil is ${coil.gauge} ga but the product is a different gauge`);
  }
  if (problems.length && b.confirm !== '1') {
    return back(`Check the coil: ${problems.join(', and ')}. Tick "Use this coil anyway" if that's right.`);
  }

  const typed = Number(b.lf_used);
  const scrap = Number(b.scrap_lf) || 0;
  // Footage typed in already includes scrap; otherwise it's pieces x length plus scrap.
  const girth = lineGirth(line);
  const used = typed > 0 ? typed : footage(pieces, len, { girth, coilWidth: coil.width_in }) + scrap;
  if (scrap > used) return back('Scrap can\'t be more than the coil feet used.');
  try {
    await tx(async (db) => {
      await db.query(`
        INSERT INTO production_runs (coil_id, order_item_id, pieces, length_in, lf_used, scrap_lf, operator)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [coil.coil_id, line.order_item_id, pieces, len, Math.round(used * 10) / 10, scrap,
        (b.operator || '').trim() || null]);
      await db.query(`UPDATE orders SET status = 'in_production' WHERE order_id = $1 AND status = 'confirmed'`, [orderId]);
    });
    res.redirect(`/orders/${orderId}#production`);
  } catch (err) {
    const msg = runError(err);
    if (!msg) throw err;
    back(msg);
  }
});

module.exports = router;
module.exports.loadOrder = loadOrder;
module.exports.loadCatalog = loadCatalog;
module.exports.saveOrder = saveOrder;
module.exports.dbMessage = dbMessage;
module.exports.UserError = UserError;
module.exports.jsonForScript = jsonForScript;
module.exports.ATTACH_TYPES = ATTACH_TYPES;
module.exports.ATTACH_MAX = ATTACH_MAX;
module.exports.fileSize = fileSize;
module.exports.isImage = isImage;
module.exports.customerSheet = customerSheet;
