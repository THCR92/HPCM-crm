// What needs someone in the office (Tyler 2026-11-12), shown as a count on the
// "Quotes & orders" menu and as the "Waiting on you" tab: a quote a customer sent from
// the portal that HPCM hasn't confirmed yet, or an order a customer placed in the portal
// that no one in the office has opened yet. Expired quotes don't count; they have their own tab.
const VALID_UNTIL = "COALESCE(o.quote_expires_on, (o.created_at AT TIME ZONE 'America/Denver')::date + 30)";
const TODAY = "(now() AT TIME ZONE 'America/Denver')::date";
const EXPIRED = `(o.status = 'quote' AND ${VALID_UNTIL} < ${TODAY})`;
const WAITING = `((o.status = 'quote' AND NOT ${EXPIRED} AND o.from_portal AND o.hpcm_confirmed_at IS NULL)
  OR (o.placed_in_portal AND o.staff_seen_at IS NULL AND o.status IN ('confirmed', 'in_production', 'ready')))`;
// Confirmed by HPCM: a quote the office wrote, or a portal quote the office confirmed.
const hpcmOk = (o) => !o.from_portal || Boolean(o.hpcm_confirmed_at);

async function waitingCount(query) {
  const { rows: [r] } = await query(`SELECT count(*)::int AS n FROM orders o WHERE ${WAITING}`);
  return r.n;
}

// Weekdays after `from` up to and including `to` (dates as YYYY-MM-DD). Holidays aren't counted out.
function businessDays(from, to) {
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  let n = 0;
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n += 1;
  }
  return n;
}
const RUSH_DAYS = 10;

module.exports = { EXPIRED, WAITING, hpcmOk, waitingCount, businessDays, RUSH_DAYS };
