// Shop TV board: a full-screen summary of where every job stands, what coil
// the next jobs need, and what's finished and waiting to leave.
const router = require('../async-router')();
const { fulfillLabel, atJob } = require('../fulfillment');
const { query } = require('../db');
const { html, money, num, date } = require('../html');
const { RUNNABLE, footage } = require('../production');
const { can } = require('../auth');

const TZ = 'America/Denver';
const READY_COUNT = 5;
const TRIM_COIL_WIDTH = 48; // trim is slit from 48" coil unless a wider one is on hand
const LIVE_COIL = "status IN ('received', 'in_stock', 'on_machine')";

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const dueText = (days) => {
  if (days === null || days === undefined) return 'No date set';
  if (days < 0) return `${plural(-days, 'day')} late`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
};
const dueClass = (days) => (days === null || days === undefined ? 'none'
  : days < 0 ? 'late' : days <= 2 ? 'soon' : 'ok');

const STATUS_TEXT = { confirmed: 'Waiting', in_production: 'In production' };

// Coil feet still to run for every approved job, by color and gauge, checked
// against the footage on hand. Jobs are served in due-date order, so a job is
// flagged short only when the coil runs out before its turn.
async function coilPlan(orderIds) {
  if (!orderIds.length) return { byOrder: new Map(), toOrder: [] };
  const [{ rows: lines }, { rows: stock }] = await Promise.all([
    query(`
      SELECT oi.order_id, oi.order_item_id, oi.pieces, COALESCE(oi.length_in, oi.per_length_in) AS length_in,
             CASE WHEN p.category = 'panel' THEN p.girth_in
                  ELSE COALESCE(oi.width_in, p.girth_in) END AS girth,
             oi.color_id, col.label AS color_label, p.gauge_id, g.gauge,
             COALESCE((SELECT sum(r.pieces) FROM production_runs r WHERE r.order_item_id = oi.order_item_id), 0) AS run_pieces,
             oi.done_at IS NOT NULL AS done
      FROM order_items oi
      JOIN products p USING (product_id)
      JOIN v_colors col ON col.color_id = oi.color_id
      LEFT JOIN gauges g ON g.gauge_id = p.gauge_id
      WHERE oi.order_id = ANY($1) AND p.category = ANY($2)`, [orderIds, RUNNABLE]),
    query(`SELECT color_id, gauge_id, sum(current_lf) AS lf, max(width_in) AS widest
           FROM coils WHERE ${LIVE_COIL} GROUP BY color_id, gauge_id`),
  ]);

  // Footage on hand per color+gauge, and per color across gauges for lines
  // whose product has no gauge (most trim).
  const onHand = new Map();
  const widest = new Map();
  for (const s of stock) {
    for (const key of [`${s.color_id}:${s.gauge_id}`, `${s.color_id}:any`]) {
      onHand.set(key, (onHand.get(key) || 0) + s.lf);
      widest.set(key, Math.max(widest.get(key) || 0, s.widest));
    }
  }

  // Feet still needed per order and material.
  const needs = new Map(); // order_id -> Map(key -> need)
  for (const l of lines) {
    // A line ticked done on the cut list needs no more coil.
    const left = l.done ? 0 : l.pieces - l.run_pieces;
    const key = `${l.color_id}:${l.gauge_id ?? 'any'}`;
    const feet = footage(left, l.length_in,
      { girth: l.girth, coilWidth: Math.max(widest.get(key) || 0, TRIM_COIL_WIDTH) });
    if (!feet) continue;
    if (!needs.has(l.order_id)) needs.set(l.order_id, new Map());
    const m = needs.get(l.order_id);
    const n = m.get(key) || { key, color: l.color_label, gauge: l.gauge, lf: 0 };
    n.lf += feet;
    m.set(key, n);
  }

  const left = new Map(onHand);
  const shortTotals = new Map();
  const byOrder = new Map();
  for (const id of orderIds) {
    const items = [...(needs.get(id)?.values() || [])].sort((a, b) => b.lf - a.lf);
    for (const n of items) {
      const avail = left.get(n.key) || 0;
      n.short = Math.max(0, n.lf - avail);
      left.set(n.key, Math.max(0, avail - n.lf));
      if (n.short > 0) {
        const t = shortTotals.get(n.key) || { color: n.color, gauge: n.gauge, lf: 0, onHand: onHand.get(n.key) || 0 };
        t.lf += n.short;
        shortTotals.set(n.key, t);
      }
    }
    byOrder.set(id, items);
  }
  const toOrder = [...shortTotals.values()].sort((a, b) => b.lf - a.lf);
  // No coil entered at all yet (the inventory isn't counted): nothing to check against.
  if (!stock.length) {
    for (const items of byOrder.values()) for (const n of items) n.short = 0;
    return { byOrder, toOrder: [], noCoil: true };
  }
  return { byOrder, toOrder };
}

router.get('/', async (req, res) => {
  const [{ rows: [counts] }, { rows: upcoming }, { rows: ready }, { rows: [week] }] = await Promise.all([
    query(`
      SELECT count(*) FILTER (WHERE o.status = 'quote')                        AS quotes,
             COALESCE(sum(t.pre_tax_total) FILTER (WHERE o.status = 'quote'), 0) AS quotes_value,
             count(*) FILTER (WHERE o.status = 'confirmed')                    AS confirmed,
             COALESCE(sum(t.pre_tax_total) FILTER (WHERE o.status = 'confirmed'), 0) AS confirmed_value,
             count(*) FILTER (WHERE o.status = 'in_production')                AS in_production,
             count(*) FILTER (WHERE o.status = 'ready')                        AS ready
      FROM orders o JOIN v_order_totals t USING (order_id)
      WHERE o.status IN ('quote', 'confirmed', 'in_production', 'ready')`),
    query(`
      SELECT o.order_id, o.order_number, o.job_name, o.status, o.need_by, o.fulfillment,
             c.display_name AS customer_name,
             o.need_by - (now() AT TIME ZONE '${TZ}')::date AS days_left
      FROM orders o JOIN customers c USING (customer_id)
      WHERE o.status IN ('confirmed', 'in_production')
      ORDER BY o.need_by NULLS LAST, o.ordered_on, o.order_id`),
    query(`
      SELECT o.order_number, o.job_name, o.fulfillment, c.display_name AS customer_name,
             (now() AT TIME ZONE '${TZ}')::date - (COALESCE(o.ready_at, o.updated_at) AT TIME ZONE '${TZ}')::date AS days_waiting
      FROM orders o JOIN customers c USING (customer_id)
      WHERE o.status = 'ready'
      ORDER BY COALESCE(o.ready_at, o.updated_at), o.order_id`),
    query(`
      WITH wk AS (SELECT date_trunc('week', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}' AS start)
      SELECT (SELECT COALESCE(sum(lf_used), 0) FROM production_runs, wk WHERE run_at >= wk.start) AS lf_run,
             (SELECT count(*) FROM orders, wk
               WHERE COALESCE(ready_at, completed_at) >= wk.start
                 AND status IN ('ready', 'completed', 'invoiced')) AS finished`),
  ]);
  const plan = await coilPlan(upcoming.map((o) => o.order_id));
  // Every approved job, by due date (Tyler 2026-11-11). When they don't all fit on the
  // screen, the page script below shows them a screenful at a time.
  const next = upcoming;
  const shortOrders = upcoming.filter((o) => plan.byOrder.get(o.order_id)?.some((n) => n.short > 0)).length;

  const now = new Date().toLocaleString('en-US', {
    timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const prices = can('prices');
  const tile = (n, label, cls, extra) => html`
    <div class="tile ${cls}"><div class="n">${n}</div><div class="txt"><div class="label">${label}</div>
      ${extra ? html`<div class="extra">${extra}</div>` : ''}</div></div>`;
  const material = (n) => html`<span class="mat ${n.short > 0 ? 'short' : ''}">
    ${n.color}${n.gauge ? html` <span class="ga">${n.gauge} ga</span>` : ''} <b>${num(n.lf, 0)} ft</b>${
      n.short > 0 ? html` <em>short ${num(n.short, 0)} ft</em>` : ''}</span>`;
  const materials = (id) => {
    const items = plan.byOrder.get(id) || [];
    if (!items.length) return '';
    const shown = items.slice(0, 2);
    return html`${shown.map(material)}${
      items.length > shown.length ? html`<span class="more">+${items.length - shown.length} more</span>` : ''}`;
  };

  res.send(String(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>Shop board · HPCM</title>
<link rel="stylesheet" href="/board.css">
<link rel="icon" href="/favicon.svg">
</head>
<body class="board">
<header>
  <img class="brand" src="/logo.svg" alt="High Plains Custom Metal">
  <div class="week">This week: <b>${num(week.lf_run, 0)} ft</b> run · <b>${week.finished}</b> ${
    week.finished === 1 ? 'order' : 'orders'} finished</div>
  <div class="clock">${now}</div>
</header>
<section class="tiles">
  ${tile(counts.quotes, 'Quotes out', 'quote', prices ? `${money(counts.quotes_value)} quoted` : '')}
  ${tile(counts.confirmed, 'Approved, waiting', 'confirmed', prices ? `${money(counts.confirmed_value)} approved` : '')}
  ${tile(counts.in_production, 'In production', 'in_production')}
  ${tile(counts.ready, 'Ready to go', 'ready')}
</section>
<div class="cols">
  <section class="next">
    <h2>Next up <span class="sub" id="next-page"></span></h2>
    ${next.length ? html`<table>
      <tbody>${next.map((o) => html`
        <tr class="due-${dueClass(o.days_left)}">
          <td class="due"><div class="when">${dueText(o.days_left)}</div><div class="date">${date(o.need_by)}</div></td>
          <td class="what">
            <div class="top"><span class="order">${o.order_number}</span>
              <span class="cust">${o.customer_name}</span>
              <span class="pill ${o.status}">${STATUS_TEXT[o.status]}</span></div>
            <div class="mats"><span class="job">${o.job_name ? `${o.job_name} · ` : ''}${
              fulfillLabel(o.fulfillment)}</span>${materials(o.order_id)}</div>
          </td>
        </tr>`)}</tbody>
    </table>` : html`<p class="empty">No approved orders waiting. Nice work.</p>`}
  </section>
  <aside>
    <section class="panel coil ${plan.toOrder.length ? 'bad' : 'good'}">
      <h2>Coil check</h2>
      ${plan.toOrder.length ? html`
        <p class="lead">${plural(shortOrders, 'approved job')} ${shortOrders === 1 ? 'needs' : 'need'} more coil than we have:</p>
        <ul>${plan.toOrder.slice(0, 4).map((t) => html`
          <li><span>${t.color}${t.gauge ? html` <span class="ga">${t.gauge} ga</span>` : ''}</span>
            <b>short ${num(t.lf, 0)} ft</b></li>`)}</ul>
        ${plan.toOrder.length > 4 ? html`<p class="more">+${plan.toOrder.length - 4} more colors</p>` : ''}`
      : plan.noCoil ? html`<p class="lead">No coil entered yet, so there's nothing to check.</p>`
        : html`<p class="lead">Coil on hand covers every approved job.</p>`}
    </section>
    <section class="panel ready">
      <h2>Ready and waiting</h2>
      ${ready.length ? html`<ul>${ready.slice(0, READY_COUNT).map((r) => html`
        <li class="${r.days_waiting >= 7 ? 'stale' : ''}">
          <div><span class="order">${r.order_number}</span> ${r.customer_name}
            <div class="job">${fulfillLabel(r.fulfillment)}${r.job_name ? ` · ${r.job_name}` : ''}</div></div>
          <b>${r.days_waiting === 0 ? 'Today' : plural(r.days_waiting, 'day')}</b></li>`)}</ul>
        ${ready.length > READY_COUNT ? html`<p class="more">+${ready.length - READY_COUNT} more</p>` : ''}`
      : html`<p class="lead muted">Nothing waiting.</p>`}
    </section>
  </aside>
</div>
<script>
// Next up: when the jobs don't all fit, show a screenful at a time, turning every 15
// seconds, and reload for fresh numbers about once a minute after a full turn. Plain ES5
// for the shop TV's browser. The meta refresh above is only a fallback.
(function () {
  var PAGE_MS = 15000, RELOAD_MS = 60000, started = new Date().getTime();
  var reload = function () { window.location.reload(); };
  var table = document.querySelector('.next table');
  var rows = table ? table.querySelectorAll('tbody tr') : [];
  var label = document.getElementById('next-page');
  var room = table ? window.innerHeight - table.getBoundingClientRect().top - 12 : 0;
  var pages = [], cur = [], used = 0, i;
  for (i = 0; i < rows.length; i++) {
    var h = rows[i].offsetHeight;
    if (cur.length && used + h > room) { pages.push(cur); cur = []; used = 0; }
    cur.push(i); used += h;
  }
  if (cur.length) pages.push(cur);
  if (pages.length < 2) { setTimeout(reload, RELOAD_MS); return; }
  var page = 0;
  function show() {
    var p = pages[page];
    for (var j = 0; j < rows.length; j++) rows[j].style.display = j >= p[0] && j <= p[p.length - 1] ? '' : 'none';
    label.textContent = (p[0] + 1) + '\u2013' + (p[p.length - 1] + 1) + ' of ' + rows.length
      + ' \u00b7 page ' + (page + 1) + ' of ' + pages.length;
  }
  show();
  setInterval(function () {
    page += 1;
    if (page >= pages.length) {
      if (new Date().getTime() - started >= RELOAD_MS) { reload(); return; }
      page = 0;
    }
    show();
  }, PAGE_MS);
}());
</script>
</body>
</html>`));
});

module.exports = router;
