// Sign-in, roles and permissions.
//
// Each person has a role. The role fills in a starting set of permissions, and
// an Admin can tick individual permissions on or off per person. Admins can
// always do everything, including managing users.
const crypto = require('crypto');
const { promisify } = require('util');
const { AsyncLocalStorage } = require('async_hooks');
const { query } = require('./db');

const scrypt = promisify(crypto.scrypt);

const ROLES = {
  admin: 'Admin',
  manager: 'Manager',
  sales: 'Sales',
  production: 'Production',
};

// Order here is the order on the Users page.
const PERMISSIONS = {
  prices: 'See prices and dollar totals',
  quotes: 'Create and edit quotes and orders',
  approve: 'Approve quotes',
  status: 'Change any status (cancel, reopen, back to quote)',
  customers: 'Add and edit customers',
  drawings: 'Attach and remove drawings',
  production: 'Log production runs and move orders to In production, Ready or Completed',
  inventory: 'Receive and adjust coils and stock',
  catalog: 'Change prices, sales tax, products, colors, finishes and suppliers',
};

const ROLE_DEFAULTS = {
  admin: Object.keys(PERMISSIONS),
  manager: ['prices', 'quotes', 'approve', 'status', 'customers', 'drawings', 'production', 'inventory'],
  sales: ['prices', 'quotes', 'approve', 'customers', 'drawings'],
  production: ['drawings', 'production', 'inventory'],
};

const SESSION_DAYS = 30;
const COOKIE = 'hpcm_session';

// ---- passwords -------------------------------------------------------------
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

const passwordProblem = (pw) => (String(pw || '').length < 8 ? 'Passwords need at least 8 characters.' : null);

// ---- the signed-in person ------------------------------------------------------
const store = new AsyncLocalStorage();
const currentUser = () => store.getStore() || null;

// Admins can do everything; everyone else needs the permission ticked.
const can = (perm, user = currentUser()) => Boolean(user && (user.role === 'admin' || user.permissions.includes(perm)));
const isAdmin = (user = currentUser()) => Boolean(user && user.role === 'admin');
const userName = (user = currentUser()) => (user ? user.full_name : null);

// ---- sessions ------------------------------------------------------------------
const parseCookies = (header) => Object.fromEntries(String(header || '').split(';')
  .map((p) => p.trim().split('=')).filter(([k, v]) => k && v !== undefined)
  .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

function setCookie(req, res, value, maxAgeSec) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

async function startSession(req, res, user) {
  const id = crypto.randomBytes(32).toString('base64url');
  await query(`INSERT INTO user_sessions (session_id, user_id, expires_at)
    VALUES ($1, $2, now() + make_interval(days => $3))`, [id, user.user_id, SESSION_DAYS]);
  await query('UPDATE users SET last_login_at = now() WHERE user_id = $1', [user.user_id]);
  setCookie(req, res, id, SESSION_DAYS * 86400);
}

async function endSession(req, res) {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  if (id) await query('DELETE FROM user_sessions WHERE session_id = $1', [id]);
  setCookie(req, res, '', 0);
}

// Loads the signed-in person (sliding 30-day expiry) and makes them available
// to every page through currentUser().
async function loadUser(req) {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  if (!id) return null;
  const { rows: [u] } = await query(`
    UPDATE user_sessions s SET last_seen_at = now(), expires_at = now() + make_interval(days => $2)
    FROM users u
    WHERE s.session_id = $1 AND u.user_id = s.user_id AND s.expires_at > now() AND u.active
    RETURNING u.user_id, u.email, u.full_name, u.role, u.permissions`, [id, SESSION_DAYS]);
  return u || null;
}

const OPEN_PATHS = ['/login', '/logout', '/healthz'];
const isAsset = (p) => /\.(css|js|svg|png|ico|jpg|webp|woff2?)$/.test(p);

function middleware() {
  return (req, res, next) => {
    if (OPEN_PATHS.includes(req.path) || isAsset(req.path)) return next();
    loadUser(req).then((user) => {
      if (!user) {
        if (req.method === 'GET' && req.accepts('html')) {
          return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
        }
        return res.status(401).json({ error: 'Your sign-in has expired. Sign in again.' });
      }
      req.user = user;
      store.run(user, next);
    }, next);
  };
}

// Route guard: need('quotes'), or need('approve', 'status') for "any of these".
const need = (...perms) => (req, res, next) => {
  if (perms.some((p) => (p === 'admin' ? isAdmin(req.user) : can(p, req.user)))) return next();
  forbid(req, res);
};

function forbid(req, res) {
  const msg = 'Your account doesn\'t have access to that. Ask an Admin if you need it.';
  if (req.accepts('html') && !req.is('json') && !req.xhr) {
    const { layout, html } = require('./html');
    return res.status(403).send(layout({ title: 'No access', body: html`<h1>No access</h1><p>${msg}</p>
      <p><a class="btn" href="/orders">Back to quotes &amp; orders</a></p>` }));
  }
  res.status(403).json({ error: msg });
}

module.exports = {
  ROLES, PERMISSIONS, ROLE_DEFAULTS, COOKIE,
  hashPassword, checkPassword, passwordProblem,
  currentUser, can, isAdmin, userName, need, forbid,
  startSession, endSession, middleware, store,
};
