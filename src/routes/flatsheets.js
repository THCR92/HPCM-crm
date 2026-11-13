// Flat sheets on hand (Tyler 2026-11-13): their own page, like coils, not Finished stock.
// One row per color, gauge and sheet size. Sheets come in (bought, or sheared from a coil,
// which takes the footage off that coil), go out (used on a job, scrapped), or get counted.
const { query, tx } = require('../db');
const { html, layout, num, date, printButton, printedLine } = require('../html');
const { feetInches } = require('../length');
const { can, need, userName } = require('../auth');

const router = require('../async-router')();

const REASON = { receive: 'Received', sheared: 'Sheared from coil', used: 'Used on a job', scrap: 'Scrapped', count: 'Count' };
const ON_HAND = "status IN ('received','in_stock','on_machine')";
const size = (s) => `${num(s.width_in, 3)}" × ${s.length_display}`;
const back = (res, error) => res.redirect(`/flat-sheets${error ? `?error=${encodeURIComponent(error)}` : ''}`);

async function colorOptions() {
  const { rows } = await query(`SELECT color_id, name, finish, finish_label, supplier_name FROM v_colors
    WHERE active ORDER BY supplier_name NULLS FIRST, name, finish_sort`);
  const groups = new Map();
  for (const c of rows) {
    const k = c.supplier_name || 'No supplier';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  return html`<option value="">Pick a color…</option>${[...groups].map(([sup, list]) => html`
    <optgroup label="${sup}">${list.map((c) => html`<option value="${c.color_id}">${c.name}${c.finish !== 'smooth' ? ` (${c.finish_label})` : ''}</option>`)}</optgroup>`)}`;
}

router.get('/flat-sheets', async (req, res) => {
  const all = req.query.show === 'all';
  const { rows: sheets } = await query(`
    SELECT s.*, col.label AS color_label, g.gauge, fn_format_length(s.length_in) AS length_display
    FROM flat_sheets s LEFT JOIN v_colors col USING (color_id) LEFT JOIN gauges g USING (gauge_id)
    ${all ? '' : 'WHERE s.qty_on_hand > 0'}
    ORDER BY col.label NULLS LAST, g.gauge, s.width_in, s.length_in DESC`);
  const { rows: log } = await query(`
    SELECT t.*, col.label AS color_label, g.gauge, s.width_in, fn_format_length(s.length_in) AS length_display, c.coil_tag
    FROM flat_sheet_transactions t JOIN flat_sheets s USING (flat_sheet_id)
    LEFT JOIN v_colors col ON col.color_id = s.color_id LEFT JOIN gauges g ON g.gauge_id = s.gauge_id
    LEFT JOIN coils c ON c.coil_id = t.coil_id
    ORDER BY t.occurred_at DESC LIMIT 25`);
  const { rows: gauges } = await query('SELECT gauge_id, gauge FROM gauges ORDER BY gauge');
  const { rows: coils } = await query(`SELECT coil_id, coil_tag, color_label, gauge, current_lf FROM v_coils WHERE ${ON_HAND} ORDER BY coil_tag`);
  const edit = can('inventory');
  const total = sheets.reduce((a, s) => a + s.qty_on_hand, 0);
  res.send(layout({
    title: 'Flat sheets', active: '/flat-sheets',
    body: html`
    <div class="page-head"><h1>Flat sheets</h1><div class="actions">${printButton('/count-sheets/flat-sheets')}
      <a class="btn" href="/flat-sheets${all ? '' : '?show=all'}">${all ? 'Hide empty' : 'Show empty'}</a></div></div>
    ${printedLine('Flat sheets on hand')}
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    ${edit ? html`<details class="card" ${sheets.length ? '' : 'open'}>
      <summary><strong>Add sheets</strong></summary>
      <form method="post" action="/flat-sheets" class="form-grid" style="margin-top:.8rem">
        <label class="span2">Color *<select name="color_id" required>${await colorOptions()}</select></label>
        <label>Gauge *<select name="gauge_id" required><option value="">Pick…</option>
          ${gauges.map((g) => html`<option value="${g.gauge_id}" ${g.gauge === 26 ? 'selected' : ''}>${g.gauge} ga</option>`)}</select></label>
        <label>Sheets *<input name="qty" type="number" min="1" step="1" required></label>
        <label>Width (in) *<input name="width_in" type="number" min="1" step="0.125" value="48" required></label>
        <label>Length *<span class="row"><input name="ft" inputmode="numeric" placeholder="ft" value="10" required><span class="unit">'</span>
          <input name="inch" placeholder="in"><span class="unit">"</span></span></label>
        <label class="span2">Sheared from coil (optional, takes the footage off the coil)
          <select name="coil_id"><option value="">Bought as sheets / already counted</option>
          ${coils.map((c) => html`<option value="${c.coil_id}">${c.coil_tag}: ${c.color_label}, ${c.gauge} ga (${num(c.current_lf, 0)} LF left)</option>`)}</select></label>
        <label>Coil feet used<input name="lf_used" type="number" step="0.1" min="0" placeholder="sheets × length"></label>
        <label>Where<input name="location" placeholder="optional, e.g. rack 2"></label>
        <div class="span2 actions"><button class="btn primary">Add sheets</button></div>
      </form>
    </details>` : ''}
    <table class="list">
      <thead><tr><th>Color</th><th>Gauge</th><th>Size</th><th>Where</th><th class="num">Sheets</th><th></th></tr></thead>
      <tbody>${sheets.length ? sheets.map((s) => html`
        <tr class="${s.qty_on_hand ? '' : 'muted'}"><td>${s.color_label || html`<span class="muted">No color</span>`}</td>
        <td>${s.gauge ? `${s.gauge} ga` : html`<span class="muted">?</span>`}</td><td>${size(s)}</td><td>${s.location || ''}</td>
        <td class="num"><strong>${s.qty_on_hand}</strong></td>
        <td class="num">${edit ? html`<form method="post" action="/flat-sheets/${s.flat_sheet_id}/change" class="inline">
          <input name="qty" type="number" min="0" step="1" placeholder="Sheets" required style="width:5.5rem">
          <select name="reason"><option value="used">Used on a job</option><option value="scrap">Scrapped</option>
            <option value="count">Counted: set to this</option></select>
          <input name="note" placeholder="Note / order #" style="width:8rem">
          <button class="btn small">Save</button></form>` : ''}</td></tr>`)
      : html`<tr><td colspan="6" class="empty">No flat sheets on hand.</td></tr>`}</tbody>
      ${sheets.length ? html`<tfoot><tr><td colspan="4">Total</td><td class="num"><strong>${total}</strong></td><td></td></tr></tfoot>` : ''}
    </table>
    ${log.length ? html`<h2>Recent changes</h2>
    <table class="list">
      <thead><tr><th>When</th><th>Sheets</th><th>What</th><th class="num">Change</th><th>Note</th><th>By</th></tr></thead>
      <tbody>${log.map((t) => html`<tr><td>${date(t.occurred_at)}</td>
        <td>${t.color_label || 'No color'}${t.gauge ? `, ${t.gauge} ga` : ''}, ${size(t)}</td>
        <td>${REASON[t.reason]}${t.coil_tag ? ` (${t.coil_tag}, ${num(t.lf_used, 1)} LF)` : ''}</td>
        <td class="num">${t.qty_delta > 0 ? '+' : ''}${t.qty_delta}</td><td>${t.note || ''}</td><td>${t.performed_by || ''}</td></tr>`)}</tbody>
    </table>` : ''}`,
  }));
});

router.post('/flat-sheets', need('inventory'), async (req, res) => {
  const b = req.body;
  const qty = Number(b.qty);
  const width = Number(b.width_in);
  const len = feetInches(b.ft, b.inch);
  const colorId = Number(b.color_id) || null;
  const gaugeId = Number(b.gauge_id) || null;
  if (!colorId || !gaugeId) return back(res, 'Pick a color and gauge.');
  if (!(qty > 0) || !Number.isInteger(qty)) return back(res, 'Enter a whole number of sheets.');
  if (!(width > 0) || !(len > 0)) return back(res, 'Enter the sheet width in inches and the length in feet and inches.');
  const coilId = Number(b.coil_id) || null;
  const lfUsed = coilId ? (Number(b.lf_used) > 0 ? Number(b.lf_used) : Math.round((qty * len) / 12 * 10) / 10) : null;
  try {
    await tx(async (db) => {
      const { rows: [s] } = await db.query(`
        INSERT INTO flat_sheets (color_id, gauge_id, width_in, length_in, location) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (color_id, gauge_id, width_in, length_in)
        DO UPDATE SET location = COALESCE(EXCLUDED.location, flat_sheets.location) RETURNING flat_sheet_id`,
      [colorId, gaugeId, width, len, String(b.location || '').trim() || null]);
      await db.query('UPDATE flat_sheets SET qty_on_hand = qty_on_hand + $2, updated_at = now() WHERE flat_sheet_id = $1', [s.flat_sheet_id, qty]);
      await db.query(`INSERT INTO flat_sheet_transactions (flat_sheet_id, reason, qty_delta, coil_id, lf_used, performed_by)
        VALUES ($1, $2, $3, $4, $5, $6)`, [s.flat_sheet_id, coilId ? 'sheared' : 'receive', qty, coilId, lfUsed, userName()]);
      if (coilId) {
        await db.query(`INSERT INTO coil_transactions (coil_id, txn_type, lf_delta, performed_by, note)
          VALUES ($1, 'production', $2, $3, $4)`, [coilId, -lfUsed, userName(), `Sheared ${qty} flat sheets`]);
      }
    });
  } catch (err) {
    return back(res, err.code === '23514' ? 'That coil doesn\'t have that many feet left.' : err.message);
  }
  back(res);
});

router.post('/flat-sheets/:id(\\d+)/change', need('inventory'), async (req, res) => {
  const qty = Number(req.body.qty);
  const reason = ['used', 'scrap', 'count'].includes(req.body.reason) ? req.body.reason : 'count';
  if (!(qty >= 0) || !Number.isInteger(qty)) return back(res, 'Enter a whole number of sheets.');
  try {
    await tx(async (db) => {
      const { rows: [s] } = await db.query('SELECT qty_on_hand FROM flat_sheets WHERE flat_sheet_id = $1 FOR UPDATE', [req.params.id]);
      if (!s) throw new Error('Not found.');
      const delta = reason === 'count' ? qty - s.qty_on_hand : -qty;
      if (s.qty_on_hand + delta < 0) throw Object.assign(new Error('There aren\'t that many sheets.'), { plain: true });
      if (!delta) return;
      await db.query('UPDATE flat_sheets SET qty_on_hand = qty_on_hand + $2, updated_at = now() WHERE flat_sheet_id = $1', [req.params.id, delta]);
      await db.query(`INSERT INTO flat_sheet_transactions (flat_sheet_id, reason, qty_delta, note, performed_by)
        VALUES ($1, $2, $3, $4, $5)`, [req.params.id, reason, delta, String(req.body.note || '').trim().slice(0, 300) || null, userName()]);
    });
  } catch (err) {
    return back(res, err.message);
  }
  back(res);
});

module.exports = router;
