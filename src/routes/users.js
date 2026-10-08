// Sign-in page, your own account, and the Admin's Users page.
const crypto = require('crypto');
const { query } = require('../db');
const {
  ROLES, PERMISSIONS, ROLE_DEFAULTS, hashPassword, checkPassword, passwordProblem,
  startSession, endSession, need, isAdmin,
} = require('../auth');
const { html, raw, layout, date } = require('../html');

const router = require('../async-router')();

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
// Only send people back to pages on this site.
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : '/orders');
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const userCount = async () => (await query('SELECT count(*)::int AS n FROM users')).rows[0].n;

// ---------------------------------------------------------------------------
// Sign in. With no users yet, the page creates the first Admin; on the live
// site that needs the old shared password (APP_PASSWORD) so strangers can't.
// ---------------------------------------------------------------------------
function loginPage({ setup, next, error, email = '', fullName = '' }) {
  const shared = Boolean(process.env.APP_PASSWORD);
  return layout({
    title: setup ? 'Set up' : 'Sign in',
    bare: true,
    body: html`
    <div class="login-box">
      <img src="/logo.svg" alt="High Plains Custom Metal">
      <h1>${setup ? 'Create the Admin account' : 'Sign in'}</h1>
      ${setup ? html`<p class="muted">This is the first sign-in with individual accounts. Create your own
        Admin account; you can add everyone else on the Users page after.</p>` : ''}
      ${error ? html`<div class="alert">${error}</div>` : ''}
      <form method="post" action="/login" class="stack">
        <input type="hidden" name="next" value="${next}">
        ${setup ? html`<label>Your name<input name="full_name" value="${fullName}" required autocomplete="name"></label>` : ''}
        <label>Email<input name="email" type="email" value="${email}" required autocomplete="username" autocapitalize="none"></label>
        <label>Password<input name="password" type="password" required
          autocomplete="${setup ? 'new-password' : 'current-password'}"></label>
        ${setup ? html`<label>Password again<input name="password2" type="password" required autocomplete="new-password"></label>
          ${shared ? html`<label>Old shared password<input name="shared" type="password" required>
            <span class="muted small">The one everyone used before. It stops working once your account is made.</span></label>` : ''}` : ''}
        <button class="btn primary">${setup ? 'Create account and sign in' : 'Sign in'}</button>
      </form>
    </div>`,
  });
}

router.get('/login', async (req, res) => {
  res.send(loginPage({ setup: (await userCount()) === 0, next: safeNext(req.query.next) }));
});

router.post('/login', async (req, res) => {
  const b = req.body;
  const next = safeNext(b.next);
  const email = String(b.email || '').trim().toLowerCase();

  if ((await userCount()) === 0) {
    const again = (error) => res.status(400).send(loginPage({ setup: true, next, error, email, fullName: b.full_name }));
    const shared = process.env.APP_PASSWORD;
    if (shared) {
      const given = Buffer.from(String(b.shared || ''));
      const want = Buffer.from(shared);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        return again('The old shared password isn\'t right.');
      }
    }
    if (blank(b.full_name) || !isEmail(email)) return again('Enter your name and your email address.');
    const problem = passwordProblem(b.password);
    if (problem) return again(problem);
    if (b.password !== b.password2) return again('The two passwords don\'t match.');
    const { rows: [u] } = await query(`
      INSERT INTO users (email, full_name, role, permissions, password_hash)
      SELECT $1, $2, 'admin', $3, $4 WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING *`,
    [email, String(b.full_name).trim(), ROLE_DEFAULTS.admin, await hashPassword(b.password)]);
    if (!u) return res.redirect('/login');
    await startSession(req, res, u);
    return res.redirect('/users?welcome=1');
  }

  const { rows: [u] } = await query('SELECT * FROM users WHERE lower(email) = $1 AND active', [email]);
  if (!u || !(await checkPassword(b.password, u.password_hash))) {
    return res.status(401).send(loginPage({ setup: false, next, email, error: 'That email and password don\'t match.' }));
  }
  await startSession(req, res, u);
  res.redirect(next);
});

router.post('/logout', async (req, res) => {
  await endSession(req, res);
  res.redirect('/login');
});

// ---------------------------------------------------------------------------
// Your account: change your own password.
// ---------------------------------------------------------------------------
router.get('/account', (req, res) => {
  const u = req.user;
  res.send(layout({
    title: 'My account',
    body: html`
    <h1>My account</h1>
    ${req.query.saved ? html`<div class="notice">Password changed.</div>` : ''}
    ${req.query.error ? html`<div class="alert">${req.query.error}</div>` : ''}
    <p>${u.full_name} · signed in as <strong>${u.email}</strong> · ${ROLES[u.role]}</p>
    <form method="post" action="/account/password" class="card form-grid" style="max-width:520px">
      <label class="span2">Current password<input name="current" type="password" required autocomplete="current-password"></label>
      <label>New password<input name="password" type="password" required autocomplete="new-password"></label>
      <label>New password again<input name="password2" type="password" required autocomplete="new-password"></label>
      <div class="span2 actions"><button class="btn primary">Change password</button></div>
    </form>`,
  }));
});

router.post('/account/password', async (req, res) => {
  const b = req.body;
  const back = (msg) => res.redirect(`/account?error=${encodeURIComponent(msg)}`);
  const { rows: [u] } = await query('SELECT password_hash FROM users WHERE user_id = $1', [req.user.user_id]);
  if (!(await checkPassword(b.current, u.password_hash))) return back('Your current password isn\'t right.');
  const problem = passwordProblem(b.password);
  if (problem) return back(problem);
  if (b.password !== b.password2) return back('The two new passwords don\'t match.');
  await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE user_id = $2',
    [await hashPassword(b.password), req.user.user_id]);
  res.redirect('/account?saved=1');
});

// ---------------------------------------------------------------------------
// Users (Admin only)
// ---------------------------------------------------------------------------
router.get('/users', need('admin'), async (req, res) => {
  const { rows: users } = await query('SELECT * FROM users ORDER BY active DESC, lower(full_name)');
  const access = (u) => (u.role === 'admin' ? 'Everything'
    : Object.keys(PERMISSIONS).filter((p) => u.permissions.includes(p)).length + ' of ' + Object.keys(PERMISSIONS).length);
  res.send(layout({
    title: 'Users', active: '/admin',
    body: html`
    <div class="page-head"><h1>Users</h1>
      <div class="actions"><a class="btn primary" href="/users/new">+ Add user</a></div></div>
    ${req.query.welcome ? html`<div class="notice">Your Admin account is ready. The old shared password no longer
      works. Add each person here with their email and their own password.</div>` : ''}
    <table class="list">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th><th>Last sign-in</th><th></th></tr></thead>
      <tbody>${users.map((u) => html`<tr class="${u.active ? '' : 'inactive'}">
        <td><a href="/users/${u.user_id}">${u.full_name}</a></td><td>${u.email}</td>
        <td>${ROLES[u.role]}${u.active ? '' : ' (turned off)'}</td><td>${access(u)}</td>
        <td>${date(u.last_login_at)}</td>
        <td class="num"><a class="btn small" href="/users/${u.user_id}">Edit</a></td></tr>`)}</tbody>
    </table>
    <h2>What each role starts with</h2>
    <table class="list role-table">
      <thead><tr><th></th>${Object.values(ROLES).map((r) => html`<th>${r}</th>`)}</tr></thead>
      <tbody>${Object.entries(PERMISSIONS).map(([p, label]) => html`<tr><td>${label}</td>
        ${Object.keys(ROLES).map((r) => html`<td class="center">${ROLE_DEFAULTS[r].includes(p) ? '✓' : ''}</td>`)}</tr>`)}
        <tr><td>Manage users</td>${Object.keys(ROLES).map((r) => html`<td class="center">${r === 'admin' ? '✓' : ''}</td>`)}</tr>
      </tbody>
    </table>
    <p class="muted">Everyone can see orders, customers, coils, stock and the shop board. You can tick
      permissions on or off for each person; Admins always have everything.</p>`,
  }));
});

function userForm(u, error) {
  const isNew = !u.user_id;
  const perms = new Set(u.permissions || ROLE_DEFAULTS[u.role || 'sales']);
  return layout({
    title: isNew ? 'Add user' : u.full_name, active: '/admin',
    body: html`
    <h1>${isNew ? 'Add user' : u.full_name}</h1>
    ${error ? html`<div class="alert">${error}</div>` : ''}
    <form method="post" action="${isNew ? '/users' : `/users/${u.user_id}`}" class="card form-grid user-form" style="max-width:720px">
      <label>Name *<input name="full_name" value="${u.full_name}" required></label>
      <label>Email *<input name="email" type="email" value="${u.email}" required autocapitalize="none" autocomplete="off">
        <span class="muted small">They sign in with this.</span></label>
      <label>Role *<select name="role">${Object.entries(ROLES).map(([k, v]) =>
    html`<option value="${k}" ${k === (u.role || 'sales') ? 'selected' : ''}>${v}</option>`)}</select></label>
      <label>${isNew ? 'Password *' : 'New password'}<input name="password" type="password" autocomplete="new-password"
        ${isNew ? 'required' : ''} placeholder="${isNew ? 'at least 8 characters' : 'leave blank to keep'}"></label>
      <fieldset class="span2 perms">
        <legend>Access</legend>
        <p class="muted small admin-note">Admins can do everything, including managing users.</p>
        ${Object.entries(PERMISSIONS).map(([p, label]) => html`
        <label class="check"><input type="checkbox" name="perm" value="${p}" ${perms.has(p) ? 'checked' : ''}> ${label}</label>`)}
      </fieldset>
      ${isNew ? '' : html`<label class="check span2"><input type="checkbox" name="active" value="1" ${u.active ? 'checked' : ''}>
        Can sign in (untick to turn this account off)</label>`}
      <div class="span2 actions"><button class="btn primary">${isNew ? 'Add user' : 'Save'}</button>
        <a class="btn" href="/users">Cancel</a></div>
    </form>
    <script>window.ROLE_DEFAULTS = ${raw(JSON.stringify(ROLE_DEFAULTS))};</script>`,
    scripts: ['/users.js'],
  });
}

const readForm = (b) => ({
  full_name: String(b.full_name || '').trim(),
  email: String(b.email || '').trim().toLowerCase(),
  role: ROLES[b.role] ? b.role : 'sales',
  permissions: [].concat(b.perm || []).filter((p) => PERMISSIONS[p]),
  active: b.active === '1',
});

async function otherActiveAdmins(userId) {
  const { rows: [r] } = await query(
    "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active AND user_id <> $1", [userId]);
  return r.n;
}

router.get('/users/new', need('admin'), (req, res) => res.send(userForm({ role: 'sales', active: true })));

router.post('/users', need('admin'), async (req, res) => {
  const u = readForm(req.body);
  if (u.role === 'admin') u.permissions = ROLE_DEFAULTS.admin;
  const problem = !u.full_name || !isEmail(u.email) ? 'Enter a name and an email address.' : passwordProblem(req.body.password);
  if (problem) return res.status(400).send(userForm(u, problem));
  try {
    await query(`INSERT INTO users (email, full_name, role, permissions, password_hash)
      VALUES ($1, $2, $3, $4, $5)`, [u.email, u.full_name, u.role, u.permissions, await hashPassword(req.body.password)]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).send(userForm(u, 'Someone already uses that email.'));
    throw err;
  }
  res.redirect('/users');
});

router.get('/users/:id(\\d+)', need('admin'), async (req, res) => {
  const { rows: [u] } = await query('SELECT * FROM users WHERE user_id = $1', [req.params.id]);
  if (!u) return res.status(404).send('User not found');
  res.send(userForm(u));
});

router.post('/users/:id(\\d+)', need('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [old] } = await query('SELECT * FROM users WHERE user_id = $1', [id]);
  if (!old) return res.status(404).send('User not found');
  const u = { ...readForm(req.body), user_id: id };
  if (u.role === 'admin') u.permissions = ROLE_DEFAULTS.admin;
  const again = (msg) => res.status(400).send(userForm(u, msg));
  if (!u.full_name || !isEmail(u.email)) return again('Enter a name and an email address.');
  if (!blank(req.body.password) && passwordProblem(req.body.password)) return again(passwordProblem(req.body.password));
  if (old.role === 'admin' && (u.role !== 'admin' || !u.active) && (await otherActiveAdmins(id)) === 0) {
    return again('This is the only Admin. Make someone else an Admin first.');
  }
  try {
    await query(`UPDATE users SET email = $2, full_name = $3, role = $4, permissions = $5, active = $6,
        password_hash = COALESCE($7, password_hash), updated_at = now() WHERE user_id = $1`,
    [id, u.email, u.full_name, u.role, u.permissions, u.active,
      blank(req.body.password) ? null : await hashPassword(req.body.password)]);
  } catch (err) {
    if (err.code === '23505') return again('Someone already uses that email.');
    throw err;
  }
  // Turned off, or given a new password: sign them out everywhere (but not the Admin doing it).
  if (!u.active || !blank(req.body.password)) {
    await query('DELETE FROM user_sessions WHERE user_id = $1 AND $1 <> $2', [id, req.user.user_id]);
  }
  res.redirect('/users');
});

module.exports = router;
