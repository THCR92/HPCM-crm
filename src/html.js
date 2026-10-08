// Tiny HTML templating: html`...` escapes every interpolated value unless it
// was produced by html`` itself or wrapped in raw(). Arrays are joined.
class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const raw = (s) => new Safe(String(s));

const escape = (v) => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const render = (v) => {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return escape(v);
};

const html = (strings, ...values) =>
  new Safe(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ''), ''));

// ---- formatting ----------------------------------------------------------
const money = (n) => (n === null || n === undefined ? '' :
  Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const num = (n, dp = 2) => (n === null || n === undefined ? '' :
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp }));
const date = (d) => {
  if (!d) return '';
  const s = typeof d === 'string' ? d : d.toISOString();
  const [y, m, day] = s.slice(0, 10).split('-');
  return `${Number(m)}/${Number(day)}/${y}`;
};

const UNIT_LABEL = { sqft: 'sq ft', lf: 'LF', each: 'ea', bag: 'bag', roll: 'roll' };
const STATUS_LABEL = {
  quote: 'Quote', confirmed: 'Confirmed', in_production: 'In production', ready: 'Ready',
  completed: 'Completed', invoiced: 'Invoiced', cancelled: 'Cancelled',
};
const AREA_LABEL = { roof: 'Roof', wall: 'Wall', trim: 'Trim', other: 'Other' };

const statusBadge = (s) => html`<span class="badge badge-${s}">${STATUS_LABEL[s] || s}</span>`;

// ---- page shell ------------------------------------------------------------
// [href, label, who sees it]
const NAV = [
  ['/orders', 'Quotes & orders'],
  ['/customers', 'Customers'],
  ['/coils', 'Coils'],
  ['/stock', 'Stock'],
  ['/products', 'Price list', 'prices'],
  ['/colors', 'Colors'],
  ['/board', 'Shop board'],
  ['/admin', 'Admin', 'admin'],
];

// Returns a plain string, ready for res.send(). `bare` leaves out the menu (sign-in page).
const layout = ({ title, active, body, scripts = [], bare = false }) => {
  const { currentUser, can, isAdmin } = require('./auth');
  const user = bare ? null : currentUser();
  const shown = NAV.filter(([, , perm]) => !perm || (perm === 'admin' ? isAdmin(user) : can(perm, user)));
  return String(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · HPCM</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/favicon.svg">
</head>
<body>
${user ? html`<header class="topbar">
  <a class="brand" href="/orders"><img src="/logo.svg" alt="High Plains Custom Metal"></a>
  ${can('quotes', user) ? html`<a class="btn quote-btn" href="/orders/new">+ Quote</a>` : ''}
  <nav>${shown.map(([href, label]) =>
    html`<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`)}</nav>
  <div class="who"><a href="/account" title="My account">${user.full_name}</a>
    <form method="post" action="/logout" class="inline"><button class="linkish">Sign out</button></form></div>
</header>` : ''}
<main>${body}</main>
${scripts.map((src) => html`<script src="${src}"></script>`)}
</body>
</html>`);
};

module.exports = {
  html, raw, money, num, date, layout, statusBadge,
  UNIT_LABEL, STATUS_LABEL, AREA_LABEL,
};
