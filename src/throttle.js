// Slows down password guessing on the staff and portal sign-in pages (audit 2026-11-17).
// Wrong tries are counted per email and per internet address, in memory (the site runs
// as one server), and forgotten 15 minutes after the first one.
const WINDOW_MS = 15 * 60 * 1000;
const PER_EMAIL = 8; // a person mistyping never gets near this
const PER_ADDRESS = 30; // one address trying many emails
const counts = new Map();

const ip = (req) => String(req.ip || req.socket?.remoteAddress || '');
const keys = (scope, req, email) => [`${scope}:ip:${ip(req)}`, ...(email ? [`${scope}:email:${email}`] : [])];
const limitFor = (key) => (key.includes(':ip:') ? PER_ADDRESS : PER_EMAIL);

function current(key) {
  const c = counts.get(key);
  if (c && Date.now() - c.first > WINDOW_MS) { counts.delete(key); return 0; }
  return c ? c.n : 0;
}

// True when this email, or this address, has had too many wrong tries lately.
const blocked = (scope, req, email) => keys(scope, req, email).some((k) => current(k) >= limitFor(k));

function miss(scope, req, email) {
  for (const k of keys(scope, req, email)) {
    if (!current(k)) counts.set(k, { n: 0, first: Date.now() });
    counts.get(k).n += 1;
  }
  if (counts.size > 50000) counts.clear(); // never let the table grow without end
}

// A right password clears the email's count (not the address's: an office shares one).
const clear = (scope, email) => counts.delete(`${scope}:email:${email}`);

const MESSAGE = 'Too many tries. Wait 15 minutes and try again, or use "Forgot password".';

module.exports = { blocked, miss, clear, reset: () => counts.clear(), MESSAGE, PER_EMAIL, PER_ADDRESS };
