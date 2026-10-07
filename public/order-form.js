// Cut-sheet order form. Reads window.ORDER_FORM = { order, products, colors, customers }
// and posts the whole order back as JSON. Billable sq ft / LF are previewed
// here with the same rules the database uses; the database is the final word.
(function () {
  const { order, products, colors, customers } = window.ORDER_FORM;
  const root = document.getElementById('order-form');
  const productById = new Map(products.map((p) => [p.id, p]));
  const colorById = new Map(colors.map((c) => [c.id, c]));

  const AREAS = { roof: 'Roof', wall: 'Wall', trim: 'Trim', other: 'Other' };
  const UNIT = { sqft: 'sq ft', lf: 'LF', each: 'ea', bag: 'bag', roll: 'roll' };
  const CATEGORY = {
    panel: 'Panels', custom_trim: 'Custom trim', trim: 'Trims & specialty cuts', flat_sheet: 'Flat sheet',
    downspout: 'Downspouts & elbows', boot: 'Boots', jack: 'Jacks', fastener: 'Screws', accessory: 'Accessories', service: 'Services',
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
    };
  };
  const state = {
    header: { ...order },
    sections: (order.sections || []).map((s) => ({
      section_id: s.section_id || null, area: s.area, label: s.label || '',
      items: (s.items || []).map(toRow),
    })),
  };
  delete state.header.sections;
  let dirty = false;

  function lengthIn(row) {
    if (row.ft === '' && row.inch === '') return null;
    const ft = row.ft === '' ? 0 : Number(row.ft);
    const inch = parseInches(row.inch);
    if (!Number.isFinite(ft) || ft < 0 || !Number.isFinite(inch)) return NaN;
    return ft * 12 + inch;
  }

  function listPrice(product, colorId) {
    if (!product || product.price === null) return '';
    const up = colorId && colorById.get(colorId) ? Number(colorById.get(colorId).upcharge) : 0;
    return round2(product.price * (1 + up / 100)).toFixed(2);
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
    // Each-priced pieces cut to a length are billed in standard lengths (6 @ 12' = 7.2 x 10'),
    // and sized trim in standard widths (10 @ 24" ridge cap = 18.46 x 13").
    else {
      const byLen = p.standard_length_in && len > 0 ? len / p.standard_length_in : 1;
      const byWidth = p.girth && width > 0 ? width / p.girth : 1;
      qty = round4(pieces * byLen * byWidth);
    }
    const sized = p.unit === 'each' && p.girth && width > 0;
    const per = p.unit === 'each' && p.standard_length_in && (len > 0 || sized) ? Number(p.standard_length_in) : null;
    const perWidth = sized ? Number(p.girth) : null;
    const tooLong = !!(p.max_length_in && len > Number(p.max_length_in));
    return { qty, amount: row.unit_price === '' ? 0 : round2(qty * price), unit: p.unit, per, perWidth, tooLong };
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
    if (p.unit === 'each' && p.girth) {
      return `<input class="w-num" data-f="width_in" type="number" step="0.125" min="0.125"
                value="${esc(row.width_in)}" placeholder="${Number(p.girth)}"
                title="Flat width in inches. The price is for ${Number(p.girth)}&quot; wide; other widths scale it."><span class="unit">" wide</span>`;
    }
    if (p.category === 'custom_trim') {
      return `<input class="w-num" data-f="width_in" type="number" step="0.125" min="0.125"
                value="${esc(row.width_in)}" placeholder="girth" title="Girth: flat stretch-out width in inches"><span class="unit">" girth</span>`;
    }
    return '';
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
        <input class="desc" data-f="description" value="${esc(row.description)}" placeholder="Note (optional)"></td>
      <td><select data-f="color_id" class="color">${colorOptions(row.color_id)}</select></td>
      <td class="width">${widthCell(row, p)}</td>
      <td class="num billed"></td>
      <td class="price-cell"><span class="unit">$</span><input class="price ${needsPrice ? 'missing' : ''}" data-f="unit_price" type="number" step="0.01" min="0"
            value="${esc(row.unit_price)}" placeholder="${p && p.price === null ? 'price' : ''}" aria-label="Unit price"></td>
      <td class="num amount"></td>
      <td><button type="button" class="icon" data-act="remove-row" title="Remove line">✕</button></td>
    </tr>`;
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
          <th>Width</th><th class="num">Billed</th><th>Price</th><th class="num">Amount</th><th></th></tr></thead>
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
      <label class="span2">Contractor / customer *
        <span class="row"><select data-h="customer_id" required>
          <option value="">Pick a customer…</option>
          ${customers.map((c) => `<option value="${c.id}" ${c.id === Number(h.customer_id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select><a href="/customers/new" target="_blank" class="small">+ New customer</a></span></label>
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
        <button type="button" class="btn primary big" data-act="save">Save order</button>
        <a class="btn" href="${h.order_id ? `/orders/${h.order_id}` : '/orders'}">Cancel</a>
      </div>
    </div>`;
  }

  function render() {
    root.innerHTML = `<div id="form-error" class="alert" hidden></div>
      ${headerHtml()}
      <div id="sections">${state.sections.map(sectionHtml).join('')}</div>
      <button type="button" class="btn" data-act="add-section">+ Add section</button>
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
    } else if (p && p.unit === 'each' && p.girth) {
      if (row.width_in === '' || row.width_in === undefined || row.lastProduct !== p.id) row.width_in = String(Number(p.girth));
    } else if (!p || p.category !== 'custom_trim') {
      row.width_in = '';
    }
    row.lastProduct = p ? p.id : null;
    row.unit_price = listPrice(p, Number(row.color_id));
  }

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
    }
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
      const used = new Set(state.sections.map((s) => s.area));
      const area = ['roof', 'wall', 'trim'].find((a) => !used.has(a)) || 'other';
      state.sections.push({ section_id: null, area, label: '', items: [] });
      dirty = true; render();
    }
    if (act === 'remove-section') {
      if (state.sections[si].items.length && !window.confirm('Remove this section and its lines?')) return;
      state.sections.splice(si, 1);
      dirty = true; render();
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
        });
      }
      sections.push({ section_id: s.section_id, area: s.area, label: s.label, items });
    }
    button.disabled = true;
    try {
      const res = await fetch(state.header.order_id ? `/orders/${state.header.order_id}` : '/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...state.header, sections }),
      });
      const out = await res.json().catch(() => ({ ok: false, error: 'The server had a problem saving this order.' }));
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
  for (const s of state.sections) if (!s.items.length) s.items.push(toRow({}));
  render();
}());
