// Reports: how the shop is doing over a date range. Sales and quotes, biggest
// customers, colors and products, the sales team, lost quotes, production and
// coil stock. Every table can be sorted and downloaded as a spreadsheet (CSV).
const router = require('../async-router')();
const { query } = require('../db');
const { html, raw, layout, money, num, date, LOST_REASONS } = require('../html');
const { can, need } = require('../auth');

const TZ = 'America/Denver';
const DAY = 86400000;
const TYPE_LABEL = { contractor: 'Contractor', homeowner: 'Homeowner', commercial: 'Commercial', dealer: 'Dealer', other: 'Other' };
const CATEGORY_LABEL = {
  panel: 'Panels', trim: 'Trim', custom_trim: 'Custom trim', flat_sheet: 'Flat sheet', boot: 'Pipe boots',
  jack: 'Roof jacks', fastener: 'Screws and clips', accessory: 'Accessories', service: 'Services', delivery: 'Delivery',
};

// ---- dates -----------------------------------------------------------------
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  ? new Date(`${s}T00:00:00Z`) : null);
const todayLocal = () => parse(new Date().toLocaleDateString('en-CA', { timeZone: TZ }));
const ymd = (y, m, d) => new Date(Date.UTC(y, m, d));

function presets(today) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const q = Math.floor(m / 3) * 3;
  return [
    ['month', 'This month', ymd(y, m, 1), today],
    ['last_month', 'Last month', ymd(y, m - 1, 1), ymd(y, m, 0)],
    ['30', 'Last 30 days', new Date(today - 29 * DAY), today],
    ['quarter', 'This quarter', ymd(y, q, 1), today],
    ['year', 'This year', ymd(y, 0, 1), today],
    ['last_year', 'Last year', ymd(y - 1, 0, 1), ymd(y - 1, 11, 31)],
    ['12', 'Last 12 months', ymd(y, m - 11, 1), today],
  ];
}

function pickRange(q) {
  const today = todayLocal();
  const list = presets(today);
  let from = parse(q.from);
  let to = parse(q.to);
  let preset = null;
  if (!from || !to) {
    const p = list.find(([k]) => k === q.range) || list.find(([k]) => k === 'year');
    [preset, , from, to] = p;
  } else if (from > to) {
    [from, to] = [to, from];
  }
  const days = Math.round((to - from) / DAY) + 1;
  // The same number of days just before, to compare against.
  const prevTo = new Date(from - DAY);
  const prevFrom = new Date(prevTo - (days - 1) * DAY);
  return {
    from: iso(from), to: iso(to), today: iso(today), days, preset, list,
    prevFrom: iso(prevFrom), prevTo: iso(prevTo),
    bucket: days <= 92 ? 'week' : 'month',
  };
}

// ---- SQL -------------------------------------------------------------------
// One row per quote/order with its dollar value (before tax) and local dates.
// A quote counts as "won" once it is approved (approved_at), even if the order
// is later cancelled; sales leave cancelled orders out.
const ORDERS = `o AS (
  SELECT o.order_id, o.order_number, o.customer_id, o.status, o.created_by, o.approved_by,
         o.fulfillment, o.need_by, o.lost_reason, o.job_name,
         o.created_at, o.approved_at, o.completed_at,
         t.pre_tax_total AS amount,
         (o.created_at   AT TIME ZONE '${TZ}')::date AS quoted_on,
         (o.approved_at  AT TIME ZONE '${TZ}')::date AS approved_on,
         (o.completed_at AT TIME ZONE '${TZ}')::date AS completed_on,
         COALESCE(o.quote_expires_on, (o.created_at AT TIME ZONE '${TZ}')::date + 30) AS valid_until,
         CASE WHEN o.approved_at IS NOT NULL THEN 'won'
              WHEN o.status = 'cancelled' THEN 'lost'
              WHEN COALESCE(o.quote_expires_on, (o.created_at AT TIME ZONE '${TZ}')::date + 30)
                   < (now() AT TIME ZONE '${TZ}')::date THEN 'expired'
              ELSE 'open' END AS outcome
  FROM orders o JOIN v_order_totals t USING (order_id))`;
// Sold in the range: approved between $1 and $2 and not cancelled since.
const SOLD = "o.approved_on BETWEEN $1 AND $2 AND o.status <> 'cancelled'";
const QUOTED = 'o.quoted_on BETWEEN $1 AND $2';

const rowsOf = async (sql, params) => (await query(sql, params)).rows;

async function headline(from, to) {
  const [r] = await rowsOf(`
    WITH ${ORDERS}
    SELECT
      count(*) FILTER (WHERE ${SOLD})                              AS sold_n,
      COALESCE(sum(amount) FILTER (WHERE ${SOLD}), 0)              AS sold,
      count(*) FILTER (WHERE ${QUOTED})                            AS quoted_n,
      COALESCE(sum(amount) FILTER (WHERE ${QUOTED}), 0)            AS quoted,
      count(*) FILTER (WHERE ${QUOTED} AND outcome = 'won')        AS won_n,
      count(*) FILTER (WHERE ${QUOTED} AND outcome IN ('won', 'lost', 'expired')) AS decided_n,
      COALESCE(sum(amount) FILTER (WHERE ${QUOTED} AND outcome = 'won'), 0) AS won,
      COALESCE(sum(amount) FILTER (WHERE ${QUOTED} AND outcome IN ('won', 'lost', 'expired')), 0) AS decided,
      avg(greatest(EXTRACT(epoch FROM approved_at - created_at) / 86400, 0)) FILTER (WHERE o.approved_on BETWEEN $1 AND $2) AS days_to_approve,
      count(*) FILTER (WHERE completed_on BETWEEN $1 AND $2 AND need_by IS NOT NULL) AS due_n,
      count(*) FILTER (WHERE completed_on BETWEEN $1 AND $2 AND completed_on <= need_by) AS ontime_n,
      avg(completed_on - approved_on) FILTER (WHERE completed_on BETWEEN $1 AND $2) AS lead_days,
      count(DISTINCT customer_id) FILTER (WHERE ${SOLD}) AS customers_n,
      (SELECT COALESCE(sum(lf_used), 0) FROM production_runs
        WHERE (run_at AT TIME ZONE '${TZ}')::date BETWEEN $1 AND $2) AS lf_run,
      (SELECT COALESCE(sum(scrap_lf), 0) FROM production_runs
        WHERE (run_at AT TIME ZONE '${TZ}')::date BETWEEN $1 AND $2) AS scrap_lf
    FROM o`, [from, to]);
  for (const k of Object.keys(r)) r[k] = r[k] === null ? null : Number(r[k]);
  return r;
}

async function snapshot() {
  const [r] = await rowsOf(`
    WITH ${ORDERS}
    SELECT count(*) FILTER (WHERE outcome = 'open')                     AS open_quotes_n,
           COALESCE(sum(amount) FILTER (WHERE outcome = 'open'), 0)     AS open_quotes,
           count(*) FILTER (WHERE status IN ('confirmed', 'in_production', 'ready')) AS shop_n,
           COALESCE(sum(amount) FILTER (WHERE status IN ('confirmed', 'in_production', 'ready')), 0) AS shop,
           count(*) FILTER (WHERE status IN ('confirmed', 'in_production')
                              AND need_by < (now() AT TIME ZONE '${TZ}')::date) AS late_n,
           count(*) FILTER (WHERE status = 'ready') AS ready_n
    FROM o`);
  for (const k of Object.keys(r)) r[k] = Number(r[k]);
  return r;
}

async function trend({ from, to, bucket }) {
  return rowsOf(`
    WITH ${ORDERS},
    b AS (SELECT s::date AS start, (s + ('1 ' || $3)::interval)::date AS stop
          FROM generate_series(date_trunc($3, $1::date::timestamp), $2::date::timestamp, ('1 ' || $3)::interval) s)
    SELECT to_char(b.start, 'YYYY-MM-DD') AS start,
      (SELECT count(*) FROM o WHERE ${QUOTED} AND quoted_on >= b.start AND quoted_on < b.stop) AS quotes_n,
      (SELECT COALESCE(sum(amount), 0) FROM o WHERE ${QUOTED} AND quoted_on >= b.start AND quoted_on < b.stop) AS quoted,
      (SELECT count(*) FROM o WHERE ${SOLD} AND approved_on >= b.start AND approved_on < b.stop) AS sold_n,
      (SELECT COALESCE(sum(amount), 0) FROM o WHERE ${SOLD} AND approved_on >= b.start AND approved_on < b.stop) AS sold,
      (SELECT COALESCE(sum(lf_used), 0) FROM production_runs r
        WHERE (r.run_at AT TIME ZONE '${TZ}')::date BETWEEN $1 AND $2
          AND (r.run_at AT TIME ZONE '${TZ}')::date >= b.start AND (r.run_at AT TIME ZONE '${TZ}')::date < b.stop) AS lf_run
    FROM b ORDER BY b.start`, [from, to, bucket]);
}

const customers = ({ from, to }) => rowsOf(`
  WITH ${ORDERS},
  firsts AS (SELECT customer_id, min(approved_on) AS first_on FROM o WHERE approved_on IS NOT NULL GROUP BY customer_id)
  SELECT c.customer_id, c.display_name AS customer, c.customer_type,
         count(*) FILTER (WHERE ${SOLD})                      AS orders,
         COALESCE(sum(amount) FILTER (WHERE ${SOLD}), 0)      AS sales,
         count(*) FILTER (WHERE ${QUOTED})                    AS quotes,
         count(*) FILTER (WHERE ${QUOTED} AND outcome = 'won') AS won,
         count(*) FILTER (WHERE ${QUOTED} AND outcome IN ('won', 'lost', 'expired')) AS decided,
         max(approved_on) FILTER (WHERE status <> 'cancelled') AS last_order,
         f.first_on BETWEEN $1 AND $2 AS is_new
  FROM o JOIN customers c USING (customer_id) LEFT JOIN firsts f USING (customer_id)
  GROUP BY c.customer_id, f.first_on
  HAVING count(*) FILTER (WHERE ${SOLD} OR ${QUOTED}) > 0
  ORDER BY sales DESC, quotes DESC, customer`, [from, to]);

// Material on the orders sold in the range. Panel square feet use the coverage
// run on the line (or the profile's usual coverage for panels sold by the foot).
const LINES = `l AS (
  SELECT oi.*, p.name AS product, p.category, p.profile_id, pp.name AS profile, g.gauge,
         CASE WHEN p.category = 'panel' THEN oi.pieces * oi.length_in / 12 END AS panel_lf,
         CASE WHEN p.category = 'panel'
              THEN oi.pieces * oi.length_in * COALESCE(oi.width_in, pp.coverage_width_in) / 144 END AS panel_sqft,
         CASE WHEN p.category IN ('trim', 'custom_trim') THEN oi.pieces END AS trim_pieces,
         CASE WHEN p.category IN ('trim', 'custom_trim')
              THEN oi.pieces * COALESCE(oi.length_in, oi.per_length_in, p.standard_length_in, 120) / 12 END AS trim_lf
  FROM order_items oi JOIN o USING (order_id) JOIN products p USING (product_id)
  LEFT JOIN panel_profiles pp ON pp.profile_id = p.profile_id
  LEFT JOIN gauges g ON g.gauge_id = p.gauge_id
  WHERE ${SOLD})`;

const colors = ({ from, to }) => rowsOf(`
  WITH ${ORDERS}, ${LINES}
  SELECT COALESCE(c.label, 'No color') AS color, count(DISTINCT l.order_id) AS orders,
         COALESCE(sum(panel_sqft), 0) AS panel_sqft, COALESCE(sum(panel_lf), 0) AS panel_lf,
         COALESCE(sum(trim_lf), 0) AS trim_lf, sum(l.line_total) AS sales
  FROM l LEFT JOIN v_colors c USING (color_id)
  WHERE l.category IN ('panel', 'trim', 'custom_trim', 'flat_sheet')
  GROUP BY c.label ORDER BY COALESCE(sum(panel_sqft), 0) + COALESCE(sum(trim_lf), 0) DESC, sales DESC`, [from, to]);

const profiles = ({ from, to }) => rowsOf(`
  WITH ${ORDERS}, ${LINES}
  SELECT profile, count(DISTINCT order_id) AS orders, sum(pieces) AS pieces,
         sum(panel_lf) AS panel_lf, sum(panel_sqft) AS panel_sqft,
         sum(panel_lf) / NULLIF(sum(pieces), 0) AS avg_length_ft, sum(line_total) AS sales
  FROM l WHERE category = 'panel' GROUP BY profile ORDER BY panel_sqft DESC`, [from, to]);

const gauges = ({ from, to }) => rowsOf(`
  WITH ${ORDERS}, ${LINES}
  SELECT gauge, count(DISTINCT order_id) AS orders, sum(panel_sqft) AS panel_sqft, sum(line_total) AS sales
  FROM l WHERE category = 'panel' GROUP BY gauge ORDER BY gauge`, [from, to]);

const categories = ({ from, to }) => rowsOf(`
  WITH ${ORDERS}, ${LINES}
  SELECT category, count(DISTINCT order_id) AS orders, sum(line_total) AS sales
  FROM l GROUP BY category ORDER BY sales DESC`, [from, to]);

const items = ({ from, to }) => rowsOf(`
  WITH ${ORDERS}, ${LINES}
  SELECT product, category, pricing_unit, count(DISTINCT order_id) AS orders, sum(pieces) AS pieces,
         sum(billable_qty) AS qty, sum(line_total) AS sales
  FROM l GROUP BY product, category, pricing_unit ORDER BY sales DESC LIMIT 25`, [from, to]);

const team = ({ from, to }) => rowsOf(`
  WITH ${ORDERS}
  SELECT COALESCE(created_by, 'Not recorded') AS person,
         count(*) FILTER (WHERE ${QUOTED}) AS quotes,
         COALESCE(sum(amount) FILTER (WHERE ${QUOTED}), 0) AS quoted,
         count(*) FILTER (WHERE ${QUOTED} AND outcome = 'won') AS won,
         count(*) FILTER (WHERE ${QUOTED} AND outcome IN ('won', 'lost', 'expired')) AS decided,
         count(*) FILTER (WHERE ${SOLD}) AS orders,
         COALESCE(sum(amount) FILTER (WHERE ${SOLD}), 0) AS sales,
         avg(greatest(EXTRACT(epoch FROM approved_at - created_at) / 86400, 0)) FILTER (WHERE approved_on BETWEEN $1 AND $2) AS days_to_approve
  FROM o GROUP BY 1
  HAVING count(*) FILTER (WHERE ${QUOTED} OR ${SOLD}) > 0
  ORDER BY sales DESC, quotes DESC`, [from, to]);

const lost = ({ from, to }) => rowsOf(`
  WITH ${ORDERS}
  SELECT CASE WHEN outcome = 'expired' THEN 'expired' ELSE COALESCE(lost_reason, 'none') END AS reason,
         count(*) AS quotes, sum(amount) AS amount
  FROM o WHERE ${QUOTED} AND outcome IN ('lost', 'expired')
  GROUP BY 1 ORDER BY quotes DESC, amount DESC`, [from, to]);

const types = ({ from, to }) => rowsOf(`
  WITH ${ORDERS}
  SELECT c.customer_type, count(DISTINCT customer_id) AS customers, count(*) AS orders, sum(amount) AS sales
  FROM o JOIN customers c USING (customer_id) WHERE ${SOLD}
  GROUP BY c.customer_type ORDER BY sales DESC`, [from, to]);

const fulfillment = ({ from, to }) => rowsOf(`
  WITH ${ORDERS}
  SELECT fulfillment, count(*) AS orders, sum(amount) AS sales
  FROM o WHERE ${SOLD} GROUP BY fulfillment ORDER BY orders DESC`, [from, to]);

const operators = ({ from, to }) => rowsOf(`
  SELECT COALESCE(operator, 'Not recorded') AS operator, count(*) AS runs, sum(pieces) AS pieces,
         sum(lf_used) AS lf_used, sum(scrap_lf) AS scrap_lf
  FROM production_runs WHERE (run_at AT TIME ZONE '${TZ}')::date BETWEEN $1 AND $2
  GROUP BY 1 ORDER BY lf_used DESC`, [from, to]);

const coilUse = ({ from, to }) => rowsOf(`
  SELECT col.label AS color, g.gauge, count(DISTINCT r.coil_id) AS coils, count(*) AS runs,
         sum(r.lf_used) AS lf_used, sum(r.scrap_lf) AS scrap_lf,
         sum(r.lf_used * c.cost_per_lf) AS cost
  FROM production_runs r JOIN coils c USING (coil_id)
  JOIN v_colors col ON col.color_id = c.color_id JOIN gauges g ON g.gauge_id = c.gauge_id
  WHERE (r.run_at AT TIME ZONE '${TZ}')::date BETWEEN $1 AND $2
  GROUP BY col.label, g.gauge ORDER BY lf_used DESC`, [from, to]);

const late = () => rowsOf(`
  SELECT o.order_id, o.order_number, o.job_name, o.status, o.need_by, c.display_name AS customer,
         (now() AT TIME ZONE '${TZ}')::date - o.need_by AS days_late
  FROM orders o JOIN customers c USING (customer_id)
  WHERE o.status IN ('confirmed', 'in_production') AND o.need_by < (now() AT TIME ZONE '${TZ}')::date
  ORDER BY o.need_by, o.order_id`);

// Coil on hand by color and gauge, against how fast it was used in the last 8 weeks.
const stock = () => rowsOf(`
  WITH used AS (
    SELECT c.color_id, c.gauge_id, -sum(t.lf_delta) AS lf_8wk
    FROM coil_transactions t JOIN coils c USING (coil_id)
    WHERE t.txn_type IN ('production', 'scrap') AND t.occurred_at >= now() - interval '56 days'
    GROUP BY 1, 2)
  SELECT col.label AS color, g.gauge, count(c.coil_id) FILTER (WHERE c.current_lf > 0) AS coils,
         COALESCE(sum(c.current_lf), 0) AS lf_on_hand, sum(c.current_lf * c.cost_per_lf) AS value,
         COALESCE(max(u.lf_8wk), 0) / 8 AS lf_per_week,
         COALESCE(sum(c.current_lf), 0) / NULLIF(max(u.lf_8wk) / 8, 0) AS weeks_left
  FROM coils c JOIN v_colors col USING (color_id) JOIN gauges g USING (gauge_id)
  LEFT JOIN used u ON u.color_id = c.color_id AND u.gauge_id = c.gauge_id
  WHERE c.status IN ('received', 'in_stock', 'on_machine')
  GROUP BY col.label, g.gauge ORDER BY weeks_left NULLS LAST, lf_on_hand DESC`);

const received = ({ from, to }) => rowsOf(`
  SELECT s.name AS supplier, count(*) AS coils, sum(c.initial_lf) AS lf, sum(c.initial_lf * c.cost_per_lf) AS cost
  FROM coils c LEFT JOIN suppliers s USING (supplier_id)
  WHERE c.received_on BETWEEN $1 AND $2
  GROUP BY s.name ORDER BY lf DESC`, [from, to]);

// ---- formatting --------------------------------------------------------------
const pct = (n, d) => (d ? (100 * n) / d : null);
const fmt = {
  money: (v) => (v === null || v === undefined ? '' : money(v)),
  money0: (v) => (v === null || v === undefined ? '' : `$${Math.round(Number(v)).toLocaleString('en-US')}`),
  num: (v) => (v === null || v === undefined ? '' : num(v, 0)),
  num1: (v) => (v === null || v === undefined ? '' : num(v, 1)),
  pct: (v) => (v === null || v === undefined ? '' : `${Math.round(v)}%`),
  date: (v) => (v ? date(v) : ''),
  text: (v) => (v === null || v === undefined ? '' : String(v)),
};
const MONEY = new Set(['money', 'money0']);

// A table spec: { id, title, note, cols: [{ key, label, type, link, csv: false }], rows }
function table(t, prices) {
  const cols = t.cols.filter((c) => prices || !MONEY.has(c.type));
  const num = (c) => c.type !== 'text' && c.type !== 'date';
  return html`
  <div class="card report-table" id="t-${t.id}">
    <div class="report-head">
      <h3>${t.title}</h3>
      ${t.rows.length ? html`<a class="small" href="?${raw(t.qs)}&csv=${t.id}" download>Download</a>` : ''}
    </div>
    ${t.note ? html`<p class="muted small">${t.note}</p>` : ''}
    ${t.rows.length ? html`
    <div class="table-wrap"><table class="list sortable">
      <thead><tr>${cols.map((c) => html`<th class="${num(c) ? 'num' : ''}" data-type="${num(c) ? 'num' : c.type}">${c.label}</th>`)}</tr></thead>
      <tbody>${t.rows.map((r) => html`<tr>${cols.map((c) => {
        const v = r[c.key];
        const shown = fmt[c.type || 'text'](v);
        const cell = c.link && c.link(r) ? html`<a href="${c.link(r)}">${shown}</a>` : shown;
        return html`<td class="${num(c) ? 'num' : ''}" data-v="${v instanceof Date ? iso(v) : v ?? ''}">${cell}</td>`;
      })}</tr>`)}</tbody>
    </table></div>` : html`<p class="muted">Nothing in this date range.</p>`}
  </div>`;
}

function csv(t, prices) {
  const cols = t.cols.filter((c) => prices || !MONEY.has(c.type));
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? iso(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => cell(c.label)), ...t.rows.map((r) => cols.map((c) => {
    const v = r[c.key];
    return cell(typeof v === 'number' && c.type !== 'text' ? Math.round(v * 100) / 100 : v);
  }))].map((r) => r.join(',')).join('\r\n');
}

// Change against the period before, as "▲ 12%".
function delta(cur, prev, { lowerIsBetter = false, points = false } = {}) {
  if (cur === null || prev === null || prev === undefined) return '';
  let change;
  if (points) change = cur - prev;
  else if (!prev) return '';
  else change = (100 * (cur - prev)) / Math.abs(prev);
  if (Math.abs(change) < 0.5) return html`<span class="delta flat">no change</span>`;
  const good = lowerIsBetter ? change < 0 : change > 0;
  return html`<span class="delta ${good ? 'up' : 'down'}">${change > 0 ? '▲' : '▼'} ${Math.round(Math.abs(change))}${points ? ' pts' : '%'}</span>`;
}

function tile(value, label, { cmp, sub } = {}) {
  return html`<div class="rtile"><div class="n">${value}</div><div class="label">${label}</div>
    ${sub ? html`<div class="sub">${sub}</div>` : ''}${cmp || ''}</div>`;
}

// Bars for one or two series over time. Values are drawn on a shared scale.
function barChart({ rows, series, labelOf, format, title }) {
  const W = 760;
  const H = 220;
  const left = 64;
  const bottom = 28;
  const top = 10;
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]))));
  const nice = (() => {
    const p = 10 ** Math.floor(Math.log10(max));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= max);
  })();
  const plotW = W - left - 8;
  const plotH = H - top - bottom;
  const slot = plotW / Math.max(rows.length, 1);
  const barW = Math.max(2, Math.min(28, (slot - 6) / series.length));
  const y = (v) => top + plotH - (plotH * v) / nice;
  const every = Math.ceil(rows.length / 14);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const gy = y(nice * f);
    return `<line x1="${left}" x2="${W - 8}" y1="${gy}" y2="${gy}" class="grid"/>`
      + `<text x="${left - 6}" y="${gy + 4}" class="axis" text-anchor="end">${esc(format(nice * f, true))}</text>`;
  }).join('');
  const bars = rows.map((r, i) => {
    const x0 = left + i * slot + (slot - barW * series.length) / 2;
    const b = series.map((s, j) => {
      const v = Number(r[s.key]);
      const by = y(v);
      return `<rect x="${x0 + j * barW}" y="${by}" width="${barW - 1}" height="${Math.max(0, top + plotH - by)}" class="${s.cls}" rx="2">`
        + `<title>${esc(`${labelOf(r)}: ${s.name} ${format(v)}`)}</title></rect>`;
    }).join('');
    const label = i % every === 0
      ? `<text x="${left + i * slot + slot / 2}" y="${H - 8}" class="axis" text-anchor="middle">${esc(labelOf(r, true))}</text>` : '';
    return b + label;
  }).join('');
  return html`<figure class="chart">
    <figcaption>${title}${series.length > 1 ? html` <span class="legend">${series.map((s) =>
      html`<span><i class="${s.cls}"></i>${s.name}</span>`)}</span>` : ''}</figcaption>
    ${raw(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}${bars}</svg>`)}
  </figure>`;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const bucketLabel = (bucket) => (r, short) => {
  const [y, m, d] = r.start.split('-').map(Number);
  if (bucket === 'month') return short ? `${MONTHS[m - 1]} ${String(y).slice(2)}` : `${MONTHS[m - 1]} ${y}`;
  return `${short ? '' : 'Week of '}${m}/${d}`;
};
const shortMoney = (v, axis) => {
  const n = Number(v);
  if (axis && n >= 1000) return `$${num(n / 1000, 1)}k`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
};

// ---- page ------------------------------------------------------------------
router.get('/reports', need('reports'), async (req, res) => {
  const range = pickRange(req.query);
  const prices = can('prices');
  const qs = range.preset ? `range=${range.preset}` : `from=${range.from}&to=${range.to}`;
  const [cur, prev, now, tr, cust, col, prof, gau, cat, top, tm, lostRows, typ, ful, ops, coil, lateRows, stk, rec] = await Promise.all([
    headline(range.from, range.to), headline(range.prevFrom, range.prevTo), snapshot(), trend(range),
    customers(range), colors(range), profiles(range), gauges(range), categories(range), items(range),
    team(range), lost(range), types(range), fulfillment(range), operators(range), coilUse(range),
    late(), stock(), received(range),
  ]);
  const N = (rows, keys) => rows.map((r) => {
    for (const k of keys) if (r[k] !== null && r[k] !== undefined) r[k] = Number(r[k]);
    return r;
  });
  const totalSales = cur.sold || 0;
  const share = (r) => pct(r.sales, totalSales);

  const tables = {
    customers: {
      title: 'Biggest customers',
      note: 'Ranked by sales in this date range. Win rate counts the quotes written for them in the range that have an answer.',
      cols: [
        { key: 'customer', label: 'Customer', link: (r) => `/customers/${r.customer_id}` },
        { key: 'type', label: 'Type' },
        { key: 'sales', label: 'Sales', type: 'money0' },
        { key: 'share', label: 'Share', type: 'pct' },
        { key: 'orders', label: 'Orders', type: 'num' },
        { key: 'avg', label: 'Average order', type: 'money0' },
        { key: 'quotes', label: 'Quotes', type: 'num' },
        { key: 'win', label: 'Win rate', type: 'pct' },
        { key: 'last_order', label: 'Last order', type: 'date' },
        { key: 'new', label: 'New?' },
      ],
      rows: N(cust, ['orders', 'sales', 'quotes', 'won', 'decided']).map((r) => ({
        ...r, type: TYPE_LABEL[r.customer_type] || r.customer_type, share: share(r),
        avg: r.orders ? r.sales / r.orders : null, win: pct(r.won, r.decided), new: r.is_new && r.orders ? 'New' : '',
      })),
    },
    types: {
      title: 'Sales by customer type',
      cols: [
        { key: 'type', label: 'Type' }, { key: 'customers', label: 'Customers', type: 'num' },
        { key: 'orders', label: 'Orders', type: 'num' }, { key: 'sales', label: 'Sales', type: 'money0' },
        { key: 'share', label: 'Share', type: 'pct' },
      ],
      rows: N(typ, ['customers', 'orders', 'sales']).map((r) => ({ ...r, type: TYPE_LABEL[r.customer_type], share: share(r) })),
    },
    fulfillment: {
      title: 'Pickup and delivery',
      cols: [
        { key: 'how', label: 'How' }, { key: 'orders', label: 'Orders', type: 'num' },
        { key: 'sales', label: 'Sales', type: 'money0' },
      ],
      rows: N(ful, ['orders', 'sales']).map((r) => ({ ...r, how: r.fulfillment === 'delivery' ? 'Delivery' : 'Pickup' })),
    },
    colors: {
      title: 'Most popular colors',
      note: 'Panels and trim on orders sold in this date range, ranked by footage.',
      cols: [
        { key: 'color', label: 'Color' }, { key: 'orders', label: 'Orders', type: 'num' },
        { key: 'panel_sqft', label: 'Panel sq ft', type: 'num' }, { key: 'panel_lf', label: 'Panel feet', type: 'num' },
        { key: 'trim_lf', label: 'Trim feet', type: 'num' }, { key: 'sales', label: 'Sales', type: 'money0' },
      ],
      rows: N(col, ['orders', 'panel_sqft', 'panel_lf', 'trim_lf', 'sales']),
    },
    profiles: {
      title: 'Panels by profile',
      cols: [
        { key: 'profile', label: 'Profile' }, { key: 'orders', label: 'Orders', type: 'num' },
        { key: 'pieces', label: 'Panels', type: 'num' }, { key: 'panel_sqft', label: 'Sq ft', type: 'num' },
        { key: 'panel_lf', label: 'Feet', type: 'num' }, { key: 'avg_length_ft', label: 'Average length (ft)', type: 'num1' },
        { key: 'sales', label: 'Sales', type: 'money0' },
      ],
      rows: N(prof, ['orders', 'pieces', 'panel_sqft', 'panel_lf', 'avg_length_ft', 'sales']),
    },
    gauges: {
      title: 'Panels by gauge',
      cols: [
        { key: 'gauge_label', label: 'Gauge' }, { key: 'orders', label: 'Orders', type: 'num' },
        { key: 'panel_sqft', label: 'Sq ft', type: 'num' }, { key: 'sales', label: 'Sales', type: 'money0' },
      ],
      rows: N(gau, ['orders', 'panel_sqft', 'sales']).map((r) => ({ ...r, gauge_label: r.gauge ? `${r.gauge} ga` : '' })),
    },
    categories: {
      title: 'Sales by product type',
      cols: [
        { key: 'label', label: 'Type' }, { key: 'orders', label: 'Orders', type: 'num' },
        { key: 'sales', label: 'Sales', type: 'money0' }, { key: 'share', label: 'Share', type: 'pct' },
      ],
      rows: N(cat, ['orders', 'sales']).map((r) => {
        const linesTotal = cat.reduce((a, x) => a + Number(x.sales), 0);
        return { ...r, label: CATEGORY_LABEL[r.category] || r.category, share: pct(r.sales, linesTotal) };
      }),
    },
    items: {
      title: 'Top 25 items',
      cols: [
        { key: 'product', label: 'Item' }, { key: 'orders', label: 'Orders', type: 'num' },
        { key: 'pieces', label: 'Pieces', type: 'num' }, { key: 'qty', label: 'Amount sold', type: 'num' },
        { key: 'unit', label: 'Unit' }, { key: 'sales', label: 'Sales', type: 'money0' },
      ],
      rows: N(top, ['orders', 'pieces', 'qty', 'sales']).map((r) => ({
        ...r, unit: { sqft: 'sq ft', lf: 'feet', each: 'each', bag: 'bags', roll: 'rolls' }[r.pricing_unit] || r.pricing_unit,
      })),
    },
    team: {
      title: 'Sales team',
      note: 'Quotes are counted for the person who wrote them.',
      cols: [
        { key: 'person', label: 'Person' }, { key: 'quotes', label: 'Quotes written', type: 'num' },
        { key: 'quoted', label: 'Quoted', type: 'money0' }, { key: 'win', label: 'Win rate', type: 'pct' },
        { key: 'orders', label: 'Orders sold', type: 'num' }, { key: 'sales', label: 'Sales', type: 'money0' },
        { key: 'days_to_approve', label: 'Days to approve', type: 'num1' },
      ],
      rows: N(tm, ['quotes', 'quoted', 'won', 'decided', 'orders', 'sales', 'days_to_approve'])
        .map((r) => ({ ...r, win: pct(r.won, r.decided) })),
    },
    lost: {
      title: 'Why quotes were lost',
      note: 'Quotes written in this date range that were cancelled, or ran past their 30 days with no answer. Pick a reason when you cancel a quote to fill this in.',
      cols: [
        { key: 'label', label: 'Reason' }, { key: 'quotes', label: 'Quotes', type: 'num' },
        { key: 'amount', label: 'Value', type: 'money0' },
      ],
      rows: N(lostRows, ['quotes', 'amount']).map((r) => ({
        ...r, label: r.reason === 'expired' ? 'Expired with no answer' : r.reason === 'none' ? 'Cancelled, no reason given' : LOST_REASONS[r.reason],
      })),
    },
    operators: {
      title: 'Production by person',
      cols: [
        { key: 'operator', label: 'Run by' }, { key: 'runs', label: 'Runs', type: 'num' },
        { key: 'pieces', label: 'Pieces', type: 'num' }, { key: 'lf_used', label: 'Coil feet', type: 'num' },
        { key: 'scrap_lf', label: 'Scrap feet', type: 'num' }, { key: 'scrap_pct', label: 'Scrap', type: 'pct' },
      ],
      rows: N(ops, ['runs', 'pieces', 'lf_used', 'scrap_lf']).map((r) => ({ ...r, scrap_pct: pct(r.scrap_lf, r.lf_used) })),
    },
    coil: {
      title: 'Coil used by color',
      cols: [
        { key: 'color', label: 'Color' }, { key: 'gauge', label: 'Gauge', type: 'num' },
        { key: 'coils', label: 'Coils', type: 'num' }, { key: 'lf_used', label: 'Feet used', type: 'num' },
        { key: 'scrap_lf', label: 'Scrap feet', type: 'num' }, { key: 'scrap_pct', label: 'Scrap', type: 'pct' },
        { key: 'cost', label: 'Coil cost', type: 'money0' },
      ],
      rows: N(coil, ['gauge', 'coils', 'runs', 'lf_used', 'scrap_lf', 'cost']).map((r) => ({ ...r, scrap_pct: pct(r.scrap_lf, r.lf_used) })),
    },
    late: {
      title: 'Late right now',
      note: 'Approved orders past their need-by date that are not finished yet.',
      cols: [
        { key: 'order_number', label: 'Order', link: (r) => `/orders/${r.order_id}` },
        { key: 'customer', label: 'Customer' }, { key: 'job_name', label: 'Job' },
        { key: 'need_by', label: 'Need by', type: 'date' }, { key: 'days_late', label: 'Days late', type: 'num' },
      ],
      rows: N(lateRows, ['days_late']),
    },
    stock: {
      title: 'Coil on hand',
      note: 'Weeks left is the footage on hand divided by the average used per week over the last 8 weeks.',
      cols: [
        { key: 'color', label: 'Color' }, { key: 'gauge', label: 'Gauge', type: 'num' },
        { key: 'coils', label: 'Coils', type: 'num' }, { key: 'lf_on_hand', label: 'Feet on hand', type: 'num' },
        { key: 'lf_per_week', label: 'Used per week', type: 'num' }, { key: 'weeks_left', label: 'Weeks left', type: 'num1' },
        { key: 'value', label: 'Value', type: 'money0' },
      ],
      rows: N(stk, ['gauge', 'coils', 'lf_on_hand', 'lf_per_week', 'weeks_left', 'value']),
    },
    received: {
      title: 'Coil received',
      cols: [
        { key: 'supplier', label: 'Supplier' }, { key: 'coils', label: 'Coils', type: 'num' },
        { key: 'lf', label: 'Feet', type: 'num' }, { key: 'cost', label: 'Cost', type: 'money0' },
      ],
      rows: N(rec, ['coils', 'lf', 'cost']).map((r) => ({ ...r, supplier: r.supplier || 'No supplier' })),
    },
  };
  for (const [id, t] of Object.entries(tables)) Object.assign(t, { id, qs });

  if (req.query.csv) {
    const t = tables[req.query.csv];
    if (!t) return res.status(404).send('Unknown report');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="hpcm-${t.id}-${range.from}-to-${range.to}.csv"`);
    return res.send(csv(t, prices));
  }

  const trendRows = N(tr, ['quotes_n', 'quoted', 'sold_n', 'sold', 'lf_run']);
  const label = bucketLabel(range.bucket);
  const winRate = pct(cur.won_n, cur.decided_n);
  const prevWin = pct(prev.won_n, prev.decided_n);
  const ontime = pct(cur.ontime_n, cur.due_n);
  const prevOntime = pct(prev.ontime_n, prev.due_n);
  const scrap = pct(cur.scrap_lf, cur.lf_run);
  const prevScrap = pct(prev.scrap_lf, prev.lf_run);
  const avgOrder = cur.sold_n ? cur.sold / cur.sold_n : null;
  const prevAvg = prev.sold_n ? prev.sold / prev.sold_n : null;
  const days = (v) => (v === null ? '–' : `${num(v, 1)} days`);
  const vs = html`<span class="muted">vs ${date(range.prevFrom)} to ${date(range.prevTo)}</span>`;

  const nav = [['sales', 'Sales and quotes'], ['customers', 'Customers'], ['products', 'Colors and products'],
    ['team', 'Sales team'], ['production', 'Production'], ['inventory', 'Coil stock']];

  res.send(layout({
    title: 'Reports',
    active: '/reports',
    scripts: ['/reports.js'],
    body: html`
    <div class="page-head"><h1>Reports</h1></div>
    <form class="card report-range" method="get" action="/reports">
      <div class="presets">${range.list.map(([k, l]) =>
        html`<a class="${range.preset === k ? 'active' : ''}" href="/reports?range=${k}">${l}</a>`)}</div>
      <label>From <input type="date" name="from" value="${range.from}"></label>
      <label>To <input type="date" name="to" value="${range.to}"></label>
      <button class="btn">Show</button>
      <span class="muted small">${date(range.from)} to ${date(range.to)} (${range.days} days). Arrows compare with the ${range.days} days before.</span>
    </form>
    <nav class="report-nav">${nav.map(([id, l]) => html`<a href="#${id}">${l}</a>`)}</nav>

    <h2 id="sales">Sales and quotes</h2>
    <div class="rtiles">
      ${prices ? tile(money(cur.sold), 'Sales', { sub: `${cur.sold_n} orders approved`, cmp: delta(cur.sold, prev.sold) }) : ''}
      ${tile(String(cur.quoted_n), 'Quotes written', { sub: prices ? `${money(cur.quoted)} quoted` : '', cmp: delta(cur.quoted_n, prev.quoted_n) })}
      ${tile(winRate === null ? '–' : fmt.pct(winRate), 'Quote win rate', {
        sub: `${cur.won_n} won of ${cur.decided_n} answered${prices && cur.decided ? `, ${fmt.pct(pct(cur.won, cur.decided))} of dollars` : ''}`,
        cmp: delta(winRate, prevWin, { points: true }) })}
      ${prices ? tile(avgOrder === null ? '–' : money(avgOrder), 'Average order', { cmp: delta(avgOrder, prevAvg) }) : ''}
      ${tile(days(cur.days_to_approve), 'Quote to approval', { sub: 'average', cmp: delta(cur.days_to_approve, prev.days_to_approve, { lowerIsBetter: true }) })}
      ${tile(String(cur.customers_n), 'Customers who bought', { cmp: delta(cur.customers_n, prev.customers_n) })}
    </div>
    <p class="small">${vs}</p>
    <div class="rtiles now">
      ${tile(String(now.open_quotes_n), 'Open quotes now', { sub: prices ? `${money(now.open_quotes)} waiting on an answer` : 'waiting on an answer' })}
      ${tile(String(now.shop_n), 'Orders in the shop now', { sub: prices ? `${money(now.shop)} of work` : '' })}
      ${tile(String(now.late_n), 'Late now', { sub: 'past need-by, not finished' })}
      ${tile(String(now.ready_n), 'Ready, waiting to leave') }
    </div>
    <div class="card">
      ${prices
        ? barChart({ rows: trendRows, title: `Quoted and sold by ${range.bucket}`, labelOf: label, format: shortMoney,
          series: [{ key: 'quoted', name: 'Quoted', cls: 's-quoted' }, { key: 'sold', name: 'Sold', cls: 's-sold' }] })
        : barChart({ rows: trendRows, title: `Quotes and orders by ${range.bucket}`, labelOf: label, format: (v) => num(v, 0),
          series: [{ key: 'quotes_n', name: 'Quotes', cls: 's-quoted' }, { key: 'sold_n', name: 'Orders', cls: 's-sold' }] })}
    </div>
    <div class="report-grid">
      ${table(tables.lost, prices)}
      ${table(tables.fulfillment, prices)}
    </div>

    <h2 id="customers">Customers</h2>
    ${table(tables.customers, prices)}
    ${table(tables.types, prices)}

    <h2 id="products">Colors and products</h2>
    ${table(tables.colors, prices)}
    ${table(tables.profiles, prices)}
    <div class="report-grid">
      ${table(tables.gauges, prices)}
      ${prices ? table(tables.categories, prices) : ''}
    </div>
    ${table(tables.items, prices)}

    <h2 id="team">Sales team</h2>
    ${table(tables.team, prices)}

    <h2 id="production">Production</h2>
    <div class="rtiles">
      ${tile(`${num(cur.lf_run, 0)} ft`, 'Coil run', { sub: `${num(cur.lf_run / Math.max(range.days / 7, 1), 0)} ft per week`, cmp: delta(cur.lf_run, prev.lf_run) })}
      ${tile(scrap === null ? '–' : `${num(scrap, 1)}%`, 'Scrap', { sub: `${num(cur.scrap_lf, 0)} ft`, cmp: delta(scrap, prevScrap, { lowerIsBetter: true, points: true }) })}
      ${tile(ontime === null ? '–' : fmt.pct(ontime), 'Finished on time', { sub: `${cur.ontime_n} of ${cur.due_n} by their need-by date`, cmp: delta(ontime, prevOntime, { points: true }) })}
      ${tile(days(cur.lead_days), 'Approval to finished', { sub: 'average', cmp: delta(cur.lead_days, prev.lead_days, { lowerIsBetter: true }) })}
    </div>
    <div class="card">
      ${barChart({ rows: trendRows, title: `Coil feet run by ${range.bucket}`, labelOf: label, format: (v) => `${num(v, 0)} ft`,
        series: [{ key: 'lf_run', name: 'Feet run', cls: 's-run' }] })}
    </div>
    ${table(tables.late, prices)}
    ${table(tables.operators, prices)}
    ${table(tables.coil, prices)}

    <h2 id="inventory">Coil stock</h2>
    ${table(tables.stock, prices)}
    ${table(tables.received, prices)}
    `,
  }));
});

module.exports = router;
module.exports.pickRange = pickRange;
