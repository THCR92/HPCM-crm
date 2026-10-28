// Cut-sheet order form. Reads window.ORDER_FORM = { order, products, colors, customers }
// and posts the whole order back as JSON. The customer portal uses it too, with
// `portal` = { prices, totals, action }: the customer is fixed, prices come from the
// price list (read-only, or hidden), and shop-only fields are left out. Billable sq ft / LF are previewed
// here with the same rules the database uses; the database is the final word.
(function () {
  const {
    order, products, colors, customers, screw_rules: screwRules = [],
    portal = null,
  } = window.ORDER_FORM;
  const root = document.getElementById('order-form');
  const productById = new Map(products.map((p) => [p.id, p]));
  const colorById = new Map(colors.map((c) => [c.id, c]));

  const AREAS = { roof: 'Roof', wall: 'Wall', trim: 'Trim', other: 'Other' };
  const UNIT = { sqft: 'sq ft', lf: 'LF', each: 'ea', bag: 'bag', roll: 'roll' };
  const CATEGORY = {
    panel: 'Panels', custom_trim: 'Custom trim', trim: 'Trims & specialty cuts', flat_sheet: 'Flat sheet',
    downspout: 'Downspouts & elbows', boot: 'Boots', jack: 'Jacks', fastener: 'Screws', accessory: 'Accessories', service: 'Services & tool rentals',
  };

  // ---------------------------------------------------------------- helpers
  const esc = (v) => (v === null || v === undefined ? '' : String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;
  const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

  // "6", "6.5", "6 1/2", "6-1/2", "1/2" -> inches; '' -> 0; junk -> NaN
  function parseInches(s) {
    s = String(s || '').trim().replace(/"$/, '');
    if (s === '') return 0;
    const m = s.match(/^(\d+(?:\.\d+)?)?(?:\s*[-\s]\s*)?(?:(\d+)\/(\d+))?$/);
    if (!m || (!m[1] && !m[2])) return NaN;
    return (m[1] ? Number(m[1]) : 0) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
  }
  // 6.5 -> "6 1/2"
  function inchesText(inch) {
    const whole = Math.floor(inch + 1e-9);
    let sixteenths = Math.round((inch - whole) * 16);
    if (sixteenths === 0) return String(whole);
    let den = 16;
    while (sixteenths % 2 === 0) { sixteenths /= 2; den /= 2; }
    return `${whole ? `${whole} ` : ''}${sixteenths}/${den}`;
  }

  // ------------------------------------------------------------------ state
  const toRow = (it) => {
    const len = it.length_in === null || it.length_in === undefined ? null : Number(it.length_in);
    return {
      order_item_id: it.order_item_id || null,
      product_id: it.product_id || null,
      lastProduct: it.product_id || null,
      color_id: it.color_id || null,
      pieces: it.pieces ?? '',
      ft: len === null ? '' : String(Math.floor(len / 12)),
      inch: len === null ? '' : inchesText(len - Math.floor(len / 12) * 12),
      width_in: it.width_in ?? '',
      unit_price: it.unit_price ?? '',
      description: it.description || '',
      screw_option: it.screw_option || '',
    };
  };
  const autoSection = (order.sections || []).find((s) => s.is_auto && s.label !== 'Closures');
  const closureSection = (order.sections || []).find((s) => s.is_auto && s.label === 'Closures');
  const state = {
    header: { ...order },
    // The automatic Screws section isn't edited by hand; it's figured from the panels.
    sections: [
      ...(order.sections || []).filter((s) => !s.is_auto).map((s) => ({
        section_id: s.section_id || null, area: s.area, label: s.label || '',
        items: (s.items || []).map(toRow),
      })),
      // Lines added by hand under the automatic Screws and Closures (shown in those boxes).
      ...['Screws', 'Closures'].map((extra) => {
        const auto = extra === 'Screws' ? autoSection : closureSection;
        return { extra, area: 'other', label: extra, items: auto ? (auto.items || []).filter((i) => i.is_added).map(toRow) : [] };
      }),
    ],
    screwSectionId: autoSection ? autoSection.section_id : null,
    closureSectionId: closureSection ? closureSection.section_id : null,
    screws: { lines: [], missing: [] },
    closures: { lines: [], missing: [] },
  };
  delete state.header.sections;
  // Opening an older order that already has screws typed in: leave them alone.
  if (state.header.auto_screws === undefined) state.header.auto_screws = false;
  if (!state.header.closures) state.header.closures = 'none';
  state.header.closure_qty = { ...(state.header.closure_qty || {}) };
  const extraOf = (name) => state.sections.findIndex((s) => s.extra === name);
  let dirty = false;

  function lengthIn(row) {
    if (row.ft === '' && row.inch === '') return null;
    const ft = row.ft === '' ? 0 : Number(row.ft);
    const inch = parseInches(row.inch);
    if (!Number.isFinite(ft) || ft < 0 || !Number.isFinite(inch)) return NaN;
    return ft * 12 + inch;
  }

  // Price of one piece: list price with the color premium; trim at its flat width
  // (26 ga $3.40 per flat inch; see public/trim-price.js).
  function listPrice(product, colorId, width) {
    const up = colorId && colorById.get(colorId) ? Number(colorById.get(colorId).upcharge) : 0;
    const price = window.TrimPrice.piecePrice(product, width, up);
    return price === null ? '' : price.toFixed(2);
  }

  // Mirrors order_items.billable_qty in the database.
  function compute(row) {
    const p = productById.get(Number(row.product_id));
    const pieces = Number(row.pieces);
    const len = lengthIn(row);
    const width = Number(row.width_in);
    const price = Number(row.unit_price);
    if (!p || !(pieces > 0)) return { qty: 0, amount: 0, unit: p ? p.unit : null };
    let qty;
    if (p.unit === 'sqft') qty = len > 0 && width > 0 ? round2((pieces * len * width) / 144) : 0;
    else if (p.unit === 'lf') qty = len > 0 ? round2((pieces * len) / 12) : 0;
    // Each-priced pieces cut to a length are billed in standard lengths (6 @ 12' = 7.2 x 10');
    // the width is already in the piece price.
    else qty = round4(pieces * (p.standard_length_in && len > 0 ? len / p.standard_length_in : 1));
    const per = p.unit === 'each' && p.standard_length_in && len > 0 ? Number(p.standard_length_in) : null;
    const perW = null;
    const tooLong = !!(p.max_length_in && len > Number(p.max_length_in));
    return { qty, amount: row.unit_price === '' ? 0 : round2(qty * price), unit: p.unit, per, perWidth: perW, tooLong };
  }

  // ----------------------------------------------------------------- render
  function productOptions(selected) {
    const groups = {};
    for (const p of products) (groups[p.category] ||= []).push(p);
    return `<option value="">Pick a product…</option>${Object.entries(groups).map(([cat, list]) =>
      `<optgroup label="${esc(CATEGORY[cat] || cat)}">${list.map((p) =>
        `<option value="${p.id}" ${p.id === Number(selected) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>`).join('')}`;
  }
  // Grouped by supplier: the same color name from two suppliers is a different color.
  function colorOptions(selected) {
    const groups = new Map();
    for (const c of colors) {
      const key = c.supplier || 'No supplier';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const opt = (c) => `<option value="${c.id}" ${c.id === Number(selected) ? 'selected' : ''}>${esc(c.name)}${
      c.finish && c.finish !== 'smooth' ? ` (${c.finish_label})` : ''}${Number(c.upcharge) ? ` +${Number(c.upcharge)}%` : ''}</option>`;
    // A line saved with a color that is now hidden still shows it.
    const hidden = selected && !colorById.has(Number(selected)) && order.hidden_colors
      ? order.hidden_colors.filter((c) => c.id === Number(selected)).map(opt).join('') : '';
    return `<option value="">—</option>${hidden}${[...groups].map(([supplier, list]) =>
      `<optgroup label="${esc(supplier)}">${list.map(opt).join('')}</optgroup>`).join('')}`;
  }

  function widthCell(row, p) {
    if (!p) return '';
    if (p.category === 'panel' && p.unit === 'sqft') {
      if (Number(p.cov_min) === Number(p.cov_max)) {
        return `<span class="fixed-width">${Number(p.cov)}" cov.</span>`;
      }
      return `<input class="w-num" data-f="width_in" type="number" step="0.125" min="${p.cov_min}" max="${p.cov_max}"
                value="${esc(row.width_in)}" title="Coverage width, ${Number(p.cov_min)}–${Number(p.cov_max)} in"><span class="unit">" cov.</span>`;
    }
    if (p.unit === 'each' && (p.girth || p.category === 'trim')) {
      const std = window.TrimPrice.standardWidth(p);
      return `<input class="w-num" data-f="width_in" type="number" step="0.125" min="0.125"
                value="${esc(row.width_in)}" placeholder="${std || 'flat'}"
                title="${p.rate ? `Flat width in inches (coil it takes). Priced at $${Number(p.rate).toFixed(2)} per flat inch.`
                  : std ? `Flat width in inches (coil it takes). The list price is for ${std}&quot; flat; other widths are priced by it.`
                    : 'Flat width in inches (coil it takes).'}"><span class="unit">" flat</span>`;
    }
    if (p.category === 'custom_trim') {
      return `<input class="w-num" data-f="width_in" type="number" step="0.125" min="0.125"
                value="${esc(row.width_in)}" placeholder="girth" title="Girth: flat stretch-out width in inches"><span class="unit">" girth</span>`;
    }
    return '';
  }

  // A choice of screw spacing on the line, e.g. ridge cap every 18" or every 9".
  function screwOptionHtml(row, p) {
    if (!p) return '';
    const { options, usual } = window.Screws.lineOptions(screwRules, p.id);
    if (options.length < 2) return '';
    const cur = options.includes(row.screw_option) ? row.screw_option : usual;
    return `<label class="screw-opt">Screws <select data-f="screw_option">${options.map((o) =>
      `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
  }

  function rowHtml(row, si, ii) {
    const p = productById.get(Number(row.product_id));
    const needsLength = p && (p.unit === 'sqft' || p.unit === 'lf');
    const lenPlaceholder = p && p.standard_length_in ? `${Math.floor(p.standard_length_in / 12)}` : '';
    const needsPrice = p && row.unit_price === '';
    return `<tr data-s="${si}" data-i="${ii}">
      <td><input class="qty" data-f="pieces" type="number" min="0" step="1" value="${esc(row.pieces)}" aria-label="Quantity"></td>
      <td class="len">
        <input class="ft" data-f="ft" inputmode="numeric" value="${esc(row.ft)}" placeholder="${lenPlaceholder}" aria-label="Feet" ${needsLength ? 'required' : ''}><span class="unit">'</span>
        <input class="in" data-f="inch" value="${esc(row.inch)}" aria-label="Inches"><span class="unit">"</span>
      </td>
      <td><select data-f="product_id" class="product">${productOptions(row.product_id)}</select>
        <input class="desc" data-f="description" value="${esc(row.description)}" placeholder="Note (optional)">${screwOptionHtml(row, p)}</td>
      <td><select data-f="color_id" class="color">${colorOptions(row.color_id)}</select></td>
      <td class="width">${widthCell(row, p)}</td>
      <td class="num billed"></td>
      <td class="price-cell"><span class="unit">$</span><input class="price ${needsPrice ? 'missing' : ''}" data-f="unit_price" type="number" step="0.01" min="0"
            value="${esc(row.unit_price)}" placeholder="${p && p.price === null ? 'price' : ''}" aria-label="Unit price" ${portal ? 'readonly tabindex="-1"' : ''}></td>
      <td class="num amount"></td>
      <td><button type="button" class="icon" data-act="remove-row" title="Remove line">✕</button></td>
    </tr>`;
  }

  // "+ Add line" under the automatic Screws or Closures lines.
  function extraHtml(name) {
    const si = extraOf(name);
    const s = state.sections[si];
    return `<fieldset class="extra-lines" data-s="${si}"><span class="section-total" hidden></span>
      ${s.items.length ? `<table class="lines edit">
        <thead><tr><th>Qty</th><th>Length (ft' in")</th><th>Added ${name.toLowerCase()}</th><th>Color</th>
          <th>Width</th><th class="num">Billed</th><th class="price-col">Price</th><th class="num amount-col">Amount</th><th></th></tr></thead>
        <tbody>${s.items.map((row, ii) => rowHtml(row, si, ii)).join('')}</tbody>
      </table>` : ''}
      <button type="button" class="btn small" data-act="add-row">+ Add line</button>
    </fieldset>`;
  }

  function sectionHtml(s, si) {
    return `<fieldset class="section" data-s="${si}">
      <div class="section-head">
        <select data-sf="area">${Object.entries(AREAS).map(([k, v]) =>
          `<option value="${k}" ${k === s.area ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input data-sf="label" value="${esc(s.label)}" placeholder="Label (optional), e.g. Garage">
        <span class="section-total"></span>
        <button type="button" class="icon" data-act="remove-section" title="Remove section">✕</button>
      </div>
      <table class="lines edit">
        <thead><tr><th>Qty</th><th>Length (ft' in")</th><th>Panel / profile</th><th>Color</th>
          <th>Width</th><th class="num">Billed</th><th class="price-col">Price</th><th class="num amount-col">Amount</th><th></th></tr></thead>
        <tbody>${s.items.map((row, ii) => rowHtml(row, si, ii)).join('')}</tbody>
      </table>
      <button type="button" class="btn small" data-act="add-row">+ Add line</button>
    </fieldset>`;
  }

  function headerHtml() {
    const h = state.header;
    const field = (name, label, type = 'text', extra = '') =>
      `<label>${label}<input data-h="${name}" type="${type}" value="${esc(h[name] ?? '')}" ${extra}></label>`;
    return `<div class="card form-grid">
      ${portal ? `<div class="span2"><span class="muted small">Customer</span><br><strong>${esc(customers[0] ? customers[0].name : '')}</strong></div>`
    : `<label class="span2">Contractor / customer *
        <span class="row"><select data-h="customer_id" required>
          <option value="">Pick a customer…</option>
          ${customers.map((c) => `<option value="${c.id}" ${c.id === Number(h.customer_id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select><a href="/customers/new" target="_blank" class="small">+ New customer</a></span></label>`}
      ${field('job_name', 'Job name')}
      ${field('po_number', 'Project / PO #')}
      ${field('need_by', 'Need by', 'date')}
      <label>Pickup or delivery
        <select data-h="fulfillment">
          <option value="pickup" ${h.fulfillment !== 'delivery' ? 'selected' : ''}>Pickup</option>
          <option value="delivery" ${h.fulfillment === 'delivery' ? 'selected' : ''}>Delivery</option>
        </select></label>
      <label class="span2">Job address<input data-h="job_address_text" value="${esc(h.job_address_text ?? '')}"></label>
      ${field('contact_phone', 'Phone', 'tel')}
      ${field('contact_email', 'Email', 'email')}
    </div>`;
  }

  function footerHtml() {
    const h = state.header;
    if (portal) return portalFooterHtml();
    const moneyField = (name, label) =>
      `<label>${label}<span class="row"><span class="unit">$</span><input data-h="${name}" type="number" step="0.01" min="0" value="${esc(h[name] || '')}"></span></label>`;
    return `<div class="form-foot">
      <div class="card form-grid">
        ${moneyField('delivery_charge', 'Delivery charge')}
        ${moneyField('discount_amount', 'Discount')}
        ${moneyField('deposit_amount', 'Deposit received')}
        <label>Sales tax<span class="row"><input data-h="tax_rate" type="number" step="0.001" min="0" max="99"
          value="${esc(h.tax_rate ?? '')}"><span class="unit">%</span></span></label>
        <label class="check"><input type="checkbox" data-h="tax_exempt" ${h.tax_exempt ? 'checked' : ''}> Tax exempt</label>
        <label class="span2">Note to customer (prints on the invoice)<textarea data-h="customer_memo" rows="2" maxlength="1000">${esc(h.customer_memo ?? '')}</textarea></label>
        <label class="span2">Shop notes (internal)<textarea data-h="internal_notes" rows="2">${esc(h.internal_notes ?? '')}</textarea></label>
        <label>Completed by<input data-h="completed_by" value="${esc(h.completed_by ?? '')}"></label>
        <label>Inspected by<input data-h="inspected_by" value="${esc(h.inspected_by ?? '')}"></label>
      </div>
      <div class="card totals-card">
        <table class="totals">
          <tr><th>Total sq ft</th><td id="t-sqft"></td></tr>
          <tr><th>Total LF</th><td id="t-lf"></td></tr>
          <tr><th>Materials</th><td id="t-lines"></td></tr>
          <tr><th>Delivery</th><td id="t-delivery"></td></tr>
          <tr><th>Discount</th><td id="t-discount"></td></tr>
          <tr><th>Subtotal</th><td id="t-subtotal"></td></tr>
          <tr><th id="t-tax-label">Sales tax</th><td id="t-tax"></td></tr>
          <tr class="grand"><th>Total</th><td id="t-total"></td></tr>
        </table>
        <label class="check accessories-check"><input type="checkbox" data-h="accessories_checked" ${h.accessories_checked ? 'checked' : ''}>
          I've added any other accessories this job needs (pipe boots, jacks, butyl tape, sealant…)</label>
        <button type="button" class="btn primary big" data-act="save">Save ${!h.status || h.status === 'quote' ? 'quote' : 'order'}</button>
        <a class="btn" href="${h.order_id ? `/orders/${h.order_id}` : '/orders'}">Cancel</a>
      </div>
    </div>`;
  }

  // The portal: a note for the shop, and totals only if this customer sees them.
  function portalFooterHtml() {
    const h = state.header;
    return `<div class="form-foot">
      <div class="card form-grid">
        <label class="span2">Notes for us (optional)<textarea data-h="customer_note" rows="3" maxlength="2000"
          placeholder="Anything we should know: trim details, delivery directions, questions">${esc(h.customer_note ?? '')}</textarea></label>
        <p class="span2 muted small">Prices are from our current price list. Add drawings for custom trim after you save.
          Saving doesn't order anything: you'll see the quote and can approve it from there.</p>
      </div>
      <div class="card totals-card">
        <table class="totals" ${portal.totals ? '' : 'hidden'}>
          <tr><th>Total sq ft</th><td id="t-sqft"></td></tr>
          <tr><th>Total LF</th><td id="t-lf"></td></tr>
          <tr hidden><th>Materials</th><td id="t-lines"></td></tr>
          <tr hidden><th>Delivery</th><td id="t-delivery"></td></tr>
          <tr hidden><th>Discount</th><td id="t-discount"></td></tr>
          <tr><th>Subtotal</th><td id="t-subtotal"></td></tr>
          <tr><th id="t-tax-label">Sales tax</th><td id="t-tax"></td></tr>
          <tr class="grand"><th>Total</th><td id="t-total"></td></tr>
        </table>
        <label class="check accessories-check"><input type="checkbox" data-h="accessories_checked" ${h.accessories_checked ? 'checked' : ''}>
          I've added any other accessories I need (pipe boots, jacks, butyl tape, sealant…)</label>
        <button type="button" class="btn primary big" data-act="save">Save quote</button>
        <a class="btn" href="${h.order_id ? `/portal/orders/${h.order_id}` : '/portal'}">Cancel</a>
      </div>
    </div>`;
  }

  // --------------------------------------------------------------- closures
  // PBR and Tuff Rib: 1 inside and 1 outside closure per panel, figured like screws.
  function panelLines() {
    return state.sections.filter((s) => !s.extra).flatMap((s) => s.items).map((row) => ({
      product_id: row.product_id, color_id: row.color_id, pieces: row.pieces, length_in: lengthIn(row), width_in: row.width_in,
      screw_option: row.screw_option,
    }));
  }
  const hasClosurePanels = () => state.sections.some((s) => s.items.some((r) => {
    const p = productById.get(Number(r.product_id));
    return p && p.category === 'panel' && p.fastening === 'through_fastened';
  }));

  const showClosures = () => hasClosurePanels() || state.sections[extraOf('Closures')].items.length > 0;

  function closuresHtml() {
    const h = state.header;
    const opt = (v, label) => `<option value="${v}" ${h.closures === v ? 'selected' : ''}>${label}</option>`;
    const { missing } = state.closures;
    // In the shop the figured counts can be changed (0 takes the line off); customers see them as figured.
    const lines = portal ? state.closures.lines : state.closures.figured;
    const qtyOf = (l) => {
      const n = h.closure_qty[l.product_id];
      return n === undefined || n === '' ? l.pieces : Number(n);
    };
    const warn = missing.length ? `<p class="alert small">No ${h.closures === 'vented' ? 'vented ' : ''}closure is set up for
      ${esc(missing.join(' or '))}. Pick "No closures" and add them as lines.</p>` : '';
    const body = h.closures === 'none'
      ? '<p class="muted small">No closures on this quote. Add them as lines if they need some.</p>'
      : !lines.length ? warn : `${warn}<table class="lines edit">
      <thead><tr><th>Qty</th><th>Closures</th><th></th><th class="num price-col">Price</th><th class="num amount-col">Amount</th></tr></thead>
      <tbody>${lines.map((l) => {
        const p = productById.get(l.product_id);
        const n = portal ? l.pieces : qtyOf(l);
        const changed = !portal && n !== l.pieces;
        return `<tr><td>${portal ? n : `<input class="qty" data-cq="${l.product_id}" type="number" min="0" step="1" value="${n}"
            aria-label="Quantity" title="Change how many; clear it to go back to ${l.pieces}">`}</td>
          <td>${esc(p ? p.name : '')}<div class="muted small">${esc(l.description)}${changed
            ? ` <strong>Changed from ${l.pieces}.</strong> <button type="button" class="linkish" data-act="closure-reset" data-p="${l.product_id}">Use ${l.pieces}</button>` : ''}</div></td><td></td>
          <td class="num price-col">${l.unit_price === '' ? '<span class="missing-text">no price set</span>' : money(Number(l.unit_price))}</td>
          <td class="num amount-col" data-amt="${l.product_id}">${l.unit_price === '' ? '' : money(round2(n * l.unit_price))}</td></tr>`;
      }).join('')}</tbody></table>`;
    return `<div class="section-head screws-head">
        <strong>Closures</strong>
        <label>Type <select data-h="closures">
          ${opt('standard', 'Standard (1 inside, 1 outside per panel)')}
          ${opt('vented', 'Vented (vented outside closure)')}
          ${opt('none', 'No closures')}</select></label>
        <span class="section-total"></span>
      </div>${body}`;
  }

  // ----------------------------------------------------------------- screws
  function figureScrews() {
    const lines = state.sections.filter((s) => !s.extra).flatMap((s) => s.items.map((row) => ({
      product_id: row.product_id, color_id: row.color_id, pieces: row.pieces, length_in: lengthIn(row), width_in: row.width_in,
      screw_option: row.screw_option, area: s.area,
    })));
    return window.Screws.figure(lines, productById, screwRules,
      { framing: state.header.framing, length: state.header.screw_length, trimFor: state.header.trim_screws_for || '' });
  }

  function screwControlsHtml() {
    const h = state.header;
    const { options: lengths, usual } = window.Screws.lengths(screwRules, h.framing);
    const current = lengths.includes(h.screw_length) ? h.screw_length : usual;
    return `<div class="section-head screws-head">
        <strong>Screws</strong>
        <label class="check"><input type="checkbox" data-h="auto_screws" ${h.auto_screws ? 'checked' : ''}> Figure screws automatically</label>
        ${h.auto_screws ? `<label>Framing <select data-h="framing">
            <option value="wood" ${h.framing !== 'steel' ? 'selected' : ''}>Wood</option>
            <option value="steel" ${h.framing === 'steel' ? 'selected' : ''}>Steel</option></select></label>
          ${lengths.length ? `<label>Length <select data-h="screw_length">${lengths.map((l) =>
            `<option ${l === current ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : ''}
          ${trimScrewsHtml()}` : ''}
        <span class="section-total"></span>
      </div>
      <div id="screws-lines"></div>`;
  }

  function renderSections() {
    return state.sections.map((s, si) => (s.extra ? '' : sectionHtml(s, si))).join('');
  }

  // "Trim screws for": shown when a line has trim with screw rules. Blank means
  // "from the panels on the quote"; with no panels someone has to pick.
  function trimScrewsHtml() {
    const hasTrim = state.sections.some((s) => s.items.some((r) => r.product_id && window.Screws.hasRules(screwRules, r.product_id)));
    if (!hasTrim) return '';
    const h = state.header;
    const inferred = state.screws.trimFor && !h.trim_screws_for ? state.screws.trimFor : '';
    const opt = (v, label) => `<option value="${v}" ${(h.trim_screws_for || '') === v ? 'selected' : ''}>${label}</option>`;
    return `<label>Trim screws for <select data-h="trim_screws_for" class="${state.screws.needsTrimChoice ? 'missing' : ''}">
        ${opt('', inferred ? `${window.Screws.SYSTEMS[inferred]} (from the panels)` : 'Pick one…')}
        ${opt('through_fastened', 'Through-fastener panels')}${opt('concealed', 'Standing seam')}${opt('none', 'No trim screws')}
      </select></label>`;
  }

  function screwLinesHtml() {
    const { lines, missing } = state.screws;
    const warn = missing.length ? `<p class="alert small">No screws are set up for ${esc(missing.join(' or '))} on
      ${state.header.framing === 'steel' ? 'steel' : 'wood'} framing, so those panels get none. Add them as lines, or an Admin can set them up under Admin &gt; Screws.</p>` : '';
    if (!state.header.auto_screws) {
      return '<p class="muted small">Add screws as lines yourself, or tick the box to figure them from the panels and trim.</p>';
    }
    const pick = state.screws.needsTrimChoice
      ? '<p class="alert small">This quote has trim but no panels. Pick which screws the trim gets ("Trim screws for").</p>' : '';
    if (!lines.length) return `${pick}${warn}<p class="muted small">Screws and clips are added here from the panels and trim on this quote.</p>`;
    return `${pick}${warn}<table class="lines edit">
      <thead><tr><th>Qty</th><th>Screws</th><th>Color</th><th class="num price-col">Price</th><th class="num amount-col">Amount</th></tr></thead>
      <tbody>${lines.map((l) => {
        const p = productById.get(l.product_id);
        const c = colorById.get(l.color_id);
        const unit = p && p.unit === 'bag' ? (l.pieces === 1 ? 'bag' : 'bags') : '';
        return `<tr><td>${l.pieces} ${unit}</td>
          <td>${esc(p ? p.name : '')}<div class="muted small">${esc(l.description)}</div></td>
          <td>${esc(c ? c.label || c.name : '')}</td>
          <td class="num price-col">${l.unit_price === '' ? '<span class="missing-text">no price set</span>' : money(Number(l.unit_price))}</td>
          <td class="num amount-col">${l.unit_price === '' ? '' : money(round2(l.pieces * l.unit_price))}</td></tr>`;
      }).join('')}</tbody></table>`;
  }

  function render() {
    if (portal && !portal.prices) root.classList.add('hide-prices');
    root.innerHTML = `<div id="form-error" class="alert" hidden></div>
      ${headerHtml()}
      <div id="sections">${renderSections()}</div>
      <button type="button" class="btn" data-act="add-section">+ Add section</button>
      <div class="section screws" id="closures-box"><div id="closures-auto"></div>${extraHtml('Closures')}</div>
      <div class="section screws" id="screws-box"><div id="screws-auto">${screwControlsHtml()}</div>${extraHtml('Screws')}</div>
      ${footerHtml()}`;
    recompute();
  }

  function recompute() {
    let sqft = 0; let lf = 0; let lines = 0; let taxable = 0;
    state.sections.forEach((s, si) => {
      let sSq = 0; let sLf = 0;
      s.items.forEach((row, ii) => {
        const tr = root.querySelector(`tr[data-s="${si}"][data-i="${ii}"]`);
        const c = compute(row);
        tr.querySelector('.billed').textContent = !c.unit ? ''
          : c.per || c.perWidth ? `${fmt(c.qty)} × ${[c.perWidth ? `${fmt(c.perWidth)}"` : '', c.per ? `${fmt(c.per / 12)}'` : '']
            .filter(Boolean).join(' × ')}` : `${fmt(c.qty)} ${UNIT[c.unit]}`;
        tr.querySelector('.ft').classList.toggle('missing', !!c.tooLong);
        tr.querySelector('.ft').title = c.tooLong ? `Longest piece is ${Number(productById.get(Number(row.product_id)).max_length_in) / 12}'` : '';
        tr.querySelector('.amount').textContent = c.unit ? money(c.amount) : '';
        tr.querySelector('.price').classList.toggle('missing', !!c.unit && row.unit_price === '');
        if (c.unit === 'sqft') sSq += c.qty;
        if (c.unit === 'lf') sLf += c.qty;
        lines += c.amount;
        if (productById.get(Number(row.product_id))?.taxable) taxable += c.amount;
      });
      sqft += sSq; lf += sLf;
      root.querySelector(`fieldset[data-s="${si}"] .section-total`).textContent =
        [sSq ? `${fmt(round2(sSq))} sq ft` : '', sLf ? `${fmt(round2(sLf))} LF` : ''].filter(Boolean).join(' · ');
    });
    const figured = hasClosurePanels() ? window.Screws.closures(panelLines(), productById, state.header.closures)
      : { lines: [], missing: [] };
    state.closures = { figured: figured.lines, missing: figured.missing,
      lines: window.Screws.withClosureQty(figured.lines, portal ? null : state.header.closure_qty) };
    let closureTotal = 0;
    for (const l of state.closures.lines) {
      if (l.unit_price === '') continue;
      const amt = round2(l.pieces * l.unit_price);
      closureTotal += amt;
      lines += amt;
      if (productById.get(l.product_id)?.taxable !== false) taxable += amt;
    }
    const cbox = root.querySelector('#closures-box');
    const cauto = root.querySelector('#closures-auto');
    const cfocus = document.activeElement && cauto.contains(document.activeElement) ? document.activeElement : null;
    cbox.hidden = !showClosures();
    if (cfocus && cfocus.dataset.cq) {
      // Typing a count: only the amounts change, so the box isn't redrawn under the cursor.
      for (const l of state.closures.figured) {
        const cell = cauto.querySelector(`[data-amt="${l.product_id}"]`);
        const n = state.closures.lines.find((x) => x.product_id === l.product_id)?.pieces || 0;
        if (cell && l.unit_price !== '') cell.textContent = money(round2(n * l.unit_price));
      }
    } else {
      cauto.innerHTML = cbox.hidden ? '' : closuresHtml();
      if (cfocus && cfocus.dataset.h) cauto.querySelector(`[data-h="${cfocus.dataset.h}"]`)?.focus();
    }
    if (!cbox.hidden) {
      cauto.querySelector('.section-total').textContent = closureTotal && (!portal || portal.prices) ? money(round2(closureTotal)) : '';
    }
    state.screws = state.header.auto_screws ? figureScrews() : { lines: [], missing: [] };
    let screwTotal = 0;
    for (const l of state.screws.lines) {
      if (l.unit_price === '') continue;
      const amt = round2(l.pieces * l.unit_price);
      screwTotal += amt;
      lines += amt;
      if (productById.get(l.product_id)?.taxable !== false) taxable += amt;
    }
    const box = root.querySelector('#screws-auto');
    const focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.h : null;
    box.innerHTML = screwControlsHtml();
    if (focused) box.querySelector(`[data-h="${focused}"]`)?.focus();
    root.querySelector('#screws-lines').innerHTML = screwLinesHtml();
    root.querySelector('#screws-auto .section-total').textContent = screwTotal && (!portal || portal.prices) ? money(round2(screwTotal)) : '';
    const delivery = Number(state.header.delivery_charge) || 0;
    const discount = Number(state.header.discount_amount) || 0;
    root.querySelector('#t-sqft').textContent = fmt(round2(sqft));
    root.querySelector('#t-lf').textContent = fmt(round2(lf));
    root.querySelector('#t-lines').textContent = money(round2(lines));
    root.querySelector('#t-delivery').textContent = money(delivery);
    root.querySelector('#t-discount').textContent = discount ? `−${money(discount)}` : money(0);
    // Mirrors v_order_totals: tax on taxable materials after the discount; delivery isn't taxed.
    const rate = Number(state.header.tax_rate) || 0;
    const base = Math.max(taxable - (lines > 0 ? (discount * taxable) / lines : 0), 0);
    const tax = state.header.tax_exempt ? 0 : round2((base * rate) / 100);
    const subtotal = round2(lines + delivery - discount);
    root.querySelector('#t-subtotal').textContent = money(subtotal);
    root.querySelector('#t-tax-label').textContent = state.header.tax_exempt ? 'Sales tax (exempt)' : `Sales tax (${rate}%)`;
    root.querySelector('#t-tax').textContent = money(tax);
    root.querySelector('#t-total').textContent = money(round2(subtotal + tax));
  }

  // ----------------------------------------------------------------- events
  function rowOf(el) {
    const tr = el.closest('tr[data-s]');
    return tr ? { row: state.sections[tr.dataset.s].items[tr.dataset.i], tr } : null;
  }

  function onProductOrColor(row) {
    const p = productById.get(Number(row.product_id));
    if (p && p.category === 'panel' && p.unit === 'sqft') {
      const w = Number(row.width_in);
      if (!(w >= Number(p.cov_min) && w <= Number(p.cov_max))) row.width_in = String(Number(p.cov));
    } else if (p && p.unit === 'each' && (p.girth || p.category === 'trim')) {
      // A new trim starts at the width its list price is for (e.g. $20.40 / $3.40 = 6").
      if (row.width_in === '' || row.width_in === undefined || row.lastProduct !== p.id) {
        const std = window.TrimPrice.standardWidth(p);
        row.width_in = std ? String(std) : '';
      }
    } else if (!p || p.category !== 'custom_trim') {
      row.width_in = '';
    }
    row.lastProduct = p ? p.id : null;
    row.unit_price = listPrice(p, Number(row.color_id), row.width_in);
  }

  root.addEventListener('change', (e) => { if (e.target.dataset.cq) setTimeout(recompute); });

  root.addEventListener('input', (e) => {
    const t = e.target;
    dirty = true;
    if (t.dataset.h) state.header[t.dataset.h] = t.type === 'checkbox' ? t.checked : t.value;
    else if (t.dataset.sf) state.sections[t.closest('fieldset').dataset.s][t.dataset.sf] = t.value;
    else if (t.dataset.f) {
      const r = rowOf(t);
      r.row[t.dataset.f] = t.value;
      if (t.dataset.f === 'product_id' || t.dataset.f === 'color_id') {
        onProductOrColor(r.row);
        const { s, i } = r.tr.dataset;
        r.tr.outerHTML = rowHtml(r.row, s, i);
      }
      // Trim: the piece price follows the flat width.
      const p = productById.get(Number(r.row.product_id));
      if (t.dataset.f === 'width_in' && p && p.unit === 'each') {
        r.row.unit_price = listPrice(p, Number(r.row.color_id), r.row.width_in);
        r.tr.querySelector('[data-f="unit_price"]').value = r.row.unit_price;
      }
    }
    if (t.dataset.cq) {
      if (t.value === '') delete state.header.closure_qty[t.dataset.cq];
      else state.header.closure_qty[t.dataset.cq] = t.value;
    }
    if (t.dataset.h === 'accessories_checked') t.closest('label').classList.toggle('missing', !t.checked);
    if (t.dataset.h === 'auto_screws') { toggleScrews(t.checked); return; }
    if (t.dataset.h === 'customer_id') {
      const c = customers.find((x) => x.id === Number(t.value));
      if (c) {
        state.header.contact_phone = state.header.contact_phone || c.phone || '';
        state.header.contact_email = state.header.contact_email || c.email || '';
        state.header.fulfillment = c.default_fulfillment;
        state.header.tax_exempt = !!c.tax_exempt;
        render();
        return;
      }
    }
    recompute();
  });

  // Turning automatic screws off keeps the screws figured so far as ordinary
  // lines; turning it on replaces a hand-made Screws section.
  function toggleScrews(on) {
    if (on) {
      const i = state.sections.findIndex((s) => s.label === 'Screws' && !s.extra);
      if (i >= 0 && (!state.sections[i].items.some((r) => r.product_id)
          || window.confirm('Replace the Screws section you typed with screws figured from the panels?'))) {
        state.sections.splice(i, 1);
      }
      state.header.auto_screws = true;
    } else {
      const figured = state.screws.lines;
      const added = state.sections[extraOf('Screws')];
      state.header.auto_screws = false;
      if (figured.length || added.items.length) {
        state.sections.splice(extraOf('Screws'), 0, {
          section_id: state.screwSectionId, area: 'other', label: 'Screws',
          items: [...figured.map((l) => toRow({ ...l, unit_price: l.unit_price === '' ? '' : Number(l.unit_price).toFixed(2) })),
            ...added.items],
        });
        added.items = [];
        state.screwSectionId = null;
      }
    }
    render();
  }

  function addRow(si) {
    const items = state.sections[si].items;
    const prev = items[items.length - 1];
    // A new line starts as a copy of the one above (same panel, color and width):
    // cut sheets are mostly several lengths of the same panel.
    items.push(prev
      ? { ...prev, order_item_id: null, pieces: '', ft: '', inch: '', description: '' }
      : toRow({}));
    render();
    const rows = root.querySelectorAll(`fieldset[data-s="${si}"] tbody tr`);
    rows[rows.length - 1].querySelector(prev ? '.qty' : '.product').focus();
  }

  root.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    const fs = e.target.closest('fieldset');
    const si = fs ? Number(fs.dataset.s) : null;
    if (act === 'add-row') addRow(si);
    if (act === 'remove-row') {
      const tr = e.target.closest('tr');
      state.sections[si].items.splice(Number(tr.dataset.i), 1);
      dirty = true; render();
    }
    if (act === 'add-section') {
      const used = new Set(state.sections.filter((s) => !s.extra).map((s) => s.area));
      const area = ['roof', 'wall', 'trim'].find((a) => !used.has(a)) || 'other';
      state.sections.splice(extraOf('Screws'), 0, { section_id: null, area, label: '', items: [] });
      dirty = true; render();
    }
    if (act === 'remove-section') {
      if (state.sections[si].items.length && !window.confirm('Remove this section and its lines?')) return;
      state.sections.splice(si, 1);
      dirty = true; render();
    }
    if (act === 'closure-reset') {
      delete state.header.closure_qty[e.target.dataset.p];
      dirty = true; recompute();
    }
    if (act === 'save') save(e.target);
  });

  // Enter in a line adds the next line (like moving down the cut sheet).
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    const tr = e.target.closest('tr[data-s]');
    if (tr && Number(tr.dataset.i) === state.sections[tr.dataset.s].items.length - 1) addRow(Number(tr.dataset.s));
  });

  function showError(msg) {
    const box = root.querySelector('#form-error');
    box.textContent = msg;
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function save(button) {
    const sections = [];
    for (const s of state.sections) {
      const items = [];
      for (const [n, row] of s.items.entries()) {
        const blank = !row.product_id && row.pieces === '' && row.ft === '' && row.inch === '';
        if (blank) continue;
        const len = lengthIn(row);
        if (Number.isNaN(len)) {
          return showError(`${AREAS[s.area]}, line ${n + 1}: the length "${row.ft}' ${row.inch}"" isn't a length I can read. Use inches like 6, 6.5 or 6 1/2.`);
        }
        items.push({
          order_item_id: row.order_item_id,
          product_id: row.product_id,
          color_id: row.color_id || null,
          pieces: row.pieces,
          length_in: len,
          width_in: row.width_in,
          unit_price: row.unit_price,
          description: row.description,
          screw_option: row.screw_option || null,
        });
      }
      if (s.extra) s.posted = items;
      else sections.push({ section_id: s.section_id, area: s.area, label: s.label, items });
    }
    const addedScrews = state.sections[extraOf('Screws')].posted;
    const addedClosures = state.sections[extraOf('Closures')].posted;
    if (!state.header.accessories_checked) {
      const box = root.querySelector('.accessories-check');
      box.classList.add('missing');
      return showError('Tick the box by the Save button once you\'ve added any other accessories (pipe boots, jacks, butyl tape, sealant…).');
    }
    // The server figures closures and screws itself; this only keeps the sections' places.
    // Lines added by hand go with them.
    if (state.closures.lines.length || addedClosures.length) {
      sections.push({ section_id: state.closureSectionId, area: 'other', label: 'Closures', auto: true, items: addedClosures });
    }
    if (state.header.auto_screws) {
      sections.push({ section_id: state.screwSectionId, area: 'other', label: 'Screws', auto: true, items: addedScrews });
    } else if (addedScrews.length) sections.push({ section_id: null, area: 'other', label: 'Screws', items: addedScrews });
    button.disabled = true;
    try {
      const url = portal ? portal.action : state.header.order_id ? `/orders/${state.header.order_id}` : '/orders';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...state.header, sections }),
      });
      const out = await res.json().catch(() => ({ ok: false,
        error: res.redirected || res.status === 401 || res.status === 403
          ? 'You were signed out or this account can\'t save quotes. Open a new tab, sign in, then come back and press Save again.'
          : `The server had a problem saving this order (error ${res.status}).` }));
      if (!out.ok) return showError(out.error);
      dirty = false;
      window.location = out.redirect;
    } catch (err) {
      showError('Could not reach the server. Check your connection and try again.');
    } finally {
      button.disabled = false;
    }
  }

  window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

  // Start every section with one empty line to type into.
  for (const s of state.sections) if (!s.items.length && !s.extra) s.items.push(toRow({}));
  render();
}());
