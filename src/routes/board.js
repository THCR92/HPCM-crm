// Shop TV board: a full-screen summary of where every job stands.
const router = require('../async-router')();
const { query } = require('../db');
const { html, money, date } = require('../html');

const TZ = 'America/Denver';

const dueText = (days) => {
  if (days === null || days === undefined) return 'No date set';
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} late`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
};
const dueClass = (days) => (days === null || days === undefined ? 'none'
  : days < 0 ? 'late' : days <= 2 ? 'soon' : 'ok');

const STATUS_TEXT = { confirmed: 'Waiting', in_production: 'In production' };

router.get('/', async (req, res) => {
  const [{ rows: [counts] }, { rows: next }] = await Promise.all([
    query(`
      SELECT count(*) FILTER (WHERE o.status = 'quote')                        AS quotes,
             COALESCE(sum(t.pre_tax_total) FILTER (WHERE o.status = 'quote'), 0) AS quotes_value,
             count(*) FILTER (WHERE o.status = 'confirmed')                    AS confirmed,
             count(*) FILTER (WHERE o.status = 'in_production')                AS in_production,
             count(*) FILTER (WHERE o.status = 'ready')                        AS ready
      FROM orders o JOIN v_order_totals t USING (order_id)
      WHERE o.status IN ('quote', 'confirmed', 'in_production', 'ready')`),
    query(`
      SELECT o.order_number, o.job_name, o.status, o.need_by, o.fulfillment,
             c.display_name AS customer_name,
             o.need_by - (now() AT TIME ZONE '${TZ}')::date AS days_left
      FROM orders o JOIN customers c USING (customer_id)
      WHERE o.status IN ('confirmed', 'in_production')
      ORDER BY o.need_by NULLS LAST, o.ordered_on, o.order_id
      LIMIT 5`),
  ]);
  const now = new Date().toLocaleString('en-US', {
    timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const tile = (n, label, cls, extra) => html`
    <div class="tile ${cls}"><div class="n">${n}</div><div class="label">${label}</div>
      ${extra ? html`<div class="extra">${extra}</div>` : ''}</div>`;

  res.send(String(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Shop board · HPCM</title>
<link rel="stylesheet" href="/board.css">
<link rel="icon" href="/favicon.svg">
</head>
<body class="board">
<header>
  <div class="brand"><strong>HIGH PLAINS</strong> CUSTOM METAL</div>
  <div class="clock">${now}</div>
</header>
<section class="tiles">
  ${tile(counts.quotes, 'Quotes out', 'quote', `${money(counts.quotes_value)} quoted`)}
  ${tile(counts.confirmed, 'Approved, waiting for production', 'confirmed')}
  ${tile(counts.in_production, 'In production', 'in_production')}
  ${tile(counts.ready, 'Ready for pickup or delivery', 'ready')}
</section>
<section class="next">
  <h2>Next up</h2>
  ${next.length ? html`<table>
    <thead><tr><th>Due</th><th>Order</th><th>Customer / job</th><th>Status</th></tr></thead>
    <tbody>${next.map((o) => html`
      <tr class="due-${dueClass(o.days_left)}">
        <td class="due"><div class="when">${dueText(o.days_left)}</div><div class="date">${date(o.need_by)}</div></td>
        <td class="order">${o.order_number}</td>
        <td><div class="cust">${o.customer_name}</div><div class="job">${o.job_name}${
          o.fulfillment === 'delivery' ? ' · Delivery' : ''}</div></td>
        <td><span class="pill ${o.status}">${STATUS_TEXT[o.status]}</span></td>
      </tr>`)}</tbody>
  </table>` : html`<p class="empty">No approved orders waiting. Nice work.</p>`}
</section>
</body>
</html>`));
});

module.exports = router;
