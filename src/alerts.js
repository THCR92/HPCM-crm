// Emails the Admins when something breaks, so they hear about it before a customer does
// (audit 2026-11-17): a page that errors, an invoice QuickBooks refuses, the QuickBooks
// connection failing, or the server itself crashing. The same problem is emailed at most
// once every 6 hours. Never throws.
const mail = require('./mail');
const { query } = require('./db');

const QUIET_MS = 6 * 60 * 60 * 1000;
const lastSent = new Map();
const site = () => (process.env.PUBLIC_URL || 'https://www.hpcmcrm.net').replace(/\/$/, '');

async function admins() {
  const { rows } = await query("SELECT email FROM users WHERE active AND role = 'admin' ORDER BY user_id");
  return rows.map((r) => r.email);
}

// `key` groups repeats of one problem; `subject` and `lines` are what the Admins read.
async function alert(key, subject, lines = []) {
  try {
    const last = lastSent.get(key);
    if (last && Date.now() - last < QUIET_MS) return false;
    if (!mail.configured()) return false;
    const to = await admins();
    if (!to.length) return false;
    lastSent.set(key, Date.now());
    return await mail.send({
      to: to.join(', '), kind: 'alert', signature: false,
      subject: `CRM problem: ${subject}`,
      text: [...lines, '', `Site: ${site()}`, `Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })} (Cheyenne)`,
        '', 'The same problem won\'t be emailed again for 6 hours.'].join('\n'),
    });
  } catch (err) {
    console.error('Alert failed:', err.message);
    return false;
  }
}

// A page that crashed: one email per page address (numbers grouped), with the error.
function pageError(err, req) {
  const where = `${req.method} ${req.path}`;
  const who = req.user ? `${req.user.full_name} (${req.user.email})` : (req.login ? `Portal: ${req.login.email}` : 'not signed in');
  return alert(`page:${req.method} ${req.path.replace(/\d+/g, 'n')}`, `a page failed (${where})`, [
    'A page in the CRM showed "Something went wrong" instead of working.', '',
    `Page: ${where}`, `Who: ${who}`, `Error: ${String(err && (err.stack || err.message) || err).slice(0, 1500)}`,
  ]);
}

module.exports = { alert, pageError, reset: () => lastSent.clear() };
