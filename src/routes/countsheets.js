// Paper count sheets for a physical inventory count: what the CRM thinks is there,
// with blank boxes to write what's actually there. "Hide what the CRM shows" makes a
// blind count, so counters write what they see instead of checking off numbers.
// Counts are entered back on the Supplies, Coils, Stock or Tools pages.
const { query } = require('../db');
const { html, layout, num, date, printedLine } = require('../html');

const router = require('../async-router')();

const HEADINGS = { boot: 'Boots', jack: 'Jacks', fastener: 'Screws', accessory: 'Accessories' };
const UNIT_WORD = { each: 'each', bag: 'bags', roll: 'rolls', lf: 'ft', sqft: 'sq ft' };
const ON_HAND = "status IN ('received','in_stock','on_machine')";
const BLANK_ROWS = 6;

const SHEETS = {
  supplies: { title: 'Supplies count sheet', back: '/supplies', backLabel: 'Supplies' },
  coils: { title: 'Coil count sheet', back: '/coils', backLabel: 'Coils' },
  stock: { title: 'Finished stock count sheet', back: '/stock', backLabel: 'Finished stock' },
  tools: { title: 'Tool count sheet', back: '/tools', backLabel: 'Tools' },
};

const group = (rows, keyOf) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m];
};
const blanks = (cols) => html`${Array.from({ length: BLANK_ROWS }, () => html`<tr>${Array.from({ length: cols }, () => html`<td>&nbsp;</td>`)}</tr>`)}`;

async function supplies(blind) {
  const { rows } = await query(`
    SELECT p.name, p.category, p.pricing_unit, p.stock_by_color, col.label AS color, s.location,
           s.supply_id, COALESCE(s.qty_on_hand, 0) AS on_hand
    FROM products p
    LEFT JOIN supply_stock s USING (product_id)
    LEFT JOIN v_colors col ON col.color_id = s.color_id
    WHERE p.track_stock AND p.active
    ORDER BY s.location NULLS LAST, array_position(enum_range(NULL::product_category), p.category), p.name, col.label NULLS FIRST`);
  const cols = blind ? 5 : 6;
  return group(rows, (r) => r.location || 'No location set').map(([loc, list]) => html`
    <h2>${loc}</h2>
    <table class="count">
      <thead><tr><th>Item</th><th>Color</th><th>Unit</th>${blind ? '' : html`<th class="num">CRM shows</th>`}<th>Counted</th><th>Notes</th></tr></thead>
      <tbody>${list.map((r) => html`<tr>
        <td>${r.name}<div class="muted small">${HEADINGS[r.category] || ''}</div></td>
        <td>${r.color || (r.stock_by_color ? html`<span class="muted small">write color</span>` : '')}</td>
        <td>${UNIT_WORD[r.pricing_unit] || r.pricing_unit}</td>
        ${blind ? '' : html`<td class="num">${num(r.on_hand)}</td>`}
        <td class="box"></td><td class="wide"></td></tr>`)}
        ${blanks(cols)}</tbody>
    </table>`);
}

async function coils(blind) {
  const { rows } = await query(`SELECT * FROM v_coils WHERE ${ON_HAND} ORDER BY color_label, gauge, width_in, coil_tag`);
  return html`
    <p class="muted small">Tick each coil that's there. Write the feet left if you measure it (or the weight off the scale). List any coil not on this sheet at the bottom.</p>
    <table class="count">
      <thead><tr><th>Coil tag</th><th>Color</th><th>Gauge</th><th class="num">Width</th>${blind ? '' : html`<th class="num">CRM feet left</th>`}
        <th>Here ✓</th><th>Feet / weight</th><th>Notes</th></tr></thead>
      <tbody>${rows.map((c) => html`<tr><td><strong>${c.coil_tag}</strong></td><td>${c.color_label}</td><td>${c.gauge}</td>
        <td class="num">${num(c.width_in, 3)}"</td>${blind ? '' : html`<td class="num">${num(c.current_lf, 0)}</td>`}
        <td class="box"></td><td class="box"></td><td class="wide"></td></tr>`)}
        ${blanks(blind ? 7 : 8)}</tbody>
    </table>`;
}

async function stock(blind) {
  const { rows } = await query(`
    SELECT p.name, col.label AS color_label, fn_format_length(fg.length_in) AS length_display, fg.qty_on_hand, fg.is_remnant
    FROM finished_goods fg JOIN products p USING (product_id) JOIN v_colors col ON col.color_id = fg.color_id
    WHERE fg.qty_on_hand > 0
    ORDER BY p.name, col.label, fg.length_in DESC`);
  return html`
    <table class="count">
      <thead><tr><th>Product</th><th>Color</th><th>Length</th>${blind ? '' : html`<th class="num">CRM pieces</th>`}<th>Counted</th><th>Notes</th></tr></thead>
      <tbody>${rows.map((s) => html`<tr><td>${s.name}${s.is_remnant ? html` <span class="muted small">remnant</span>` : ''}</td>
        <td>${s.color_label}</td><td>${s.length_display}</td>${blind ? '' : html`<td class="num">${s.qty_on_hand}</td>`}
        <td class="box"></td><td class="wide"></td></tr>`)}
        ${blanks(blind ? 5 : 6)}</tbody>
    </table>`;
}

async function tools() {
  const { rows } = await query(`
    SELECT t.name, t.tag, t.location, t.status, o.order_number, c.display_name AS customer
    FROM tools t
    LEFT JOIN tool_rentals r ON r.tool_id = t.tool_id AND r.returned_at IS NULL
    LEFT JOIN orders o ON o.order_id = r.order_id
    LEFT JOIN customers c ON c.customer_id = o.customer_id
    WHERE t.status <> 'retired'
    ORDER BY t.location NULLS LAST, t.name, t.tag`);
  return group(rows, (r) => r.location || 'No location set').map(([loc, list]) => html`
    <h2>${loc}</h2>
    <table class="count">
      <thead><tr><th>Tool</th><th>Tag</th><th>CRM says</th><th>Here ✓</th><th>Condition / notes</th></tr></thead>
      <tbody>${list.map((t) => html`<tr><td>${t.name}</td><td>${t.tag}</td>
        <td>${t.order_number ? `Out with ${t.customer} (${t.order_number})` : t.status === 'repair' ? 'In for repair' : 'In the shop'}</td>
        <td class="box"></td><td class="wide"></td></tr>`)}
        ${blanks(5)}</tbody>
    </table>`);
}

const BUILD = { supplies, coils, stock, tools };

router.get('/count-sheets/:kind(supplies|coils|stock|tools)', async (req, res) => {
  const kind = req.params.kind;
  const sheet = SHEETS[kind];
  const blind = req.query.blind === '1' && kind !== 'tools';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  res.send(layout({
    title: sheet.title, active: sheet.back,
    body: html`
    <div class="count-sheet">
      <div class="page-head no-print"><h1>${sheet.title}</h1>
        <div class="actions"><button type="button" class="btn primary" onclick="window.print()">Print</button>
          <a class="btn" href="${sheet.back}">Back to ${sheet.backLabel}</a></div></div>
      ${kind === 'tools' ? '' : html`<div class="count-opts no-print">
        <a class="btn ${blind ? '' : 'primary'}" href="/count-sheets/${kind}">Show what the CRM has</a>
        <a class="btn ${blind ? 'primary' : ''}" href="/count-sheets/${kind}?blind=1">Blind count (hide it)</a>
        <span class="muted small">A blind count has counters write what they see instead of checking numbers off.</span></div>`}
      <h1 class="print-only">${sheet.title}</h1>
      ${printedLine(`${sheet.title}${blind ? ' (blind)' : ''}, as of ${date(today)}`)}
      ${await BUILD[kind](blind)}
      <div class="signoff"><span>Counted by:</span><span>Date:</span><span>Entered in CRM by:</span></div>
      <p class="muted small no-print">After counting, enter the numbers on the ${sheet.backLabel} page.</p>
    </div>`,
  }));
});

module.exports = router;
