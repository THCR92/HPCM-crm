// Customer types and the price premium each pays (Tyler 2026-11-11): a percent added to
// price list prices on quotes and orders, e.g. homeowners +15%, supply houses -10%.
const { query } = require('./db');

const TYPE_LABEL = {
  contractor: 'Contractor / Builder', homeowner: 'Homeowner', supply_house: 'Supply house',
  commercial: 'Commercial', dealer: 'Dealer', other: 'Other',
};
const TYPES = Object.keys(TYPE_LABEL);

// { contractor: 0, homeowner: 15, ... } with 0 for types not set.
async function premiums(db = { query }) {
  const { rows } = await db.query('SELECT customer_type::text AS t, premium_pct FROM customer_type_premiums');
  const out = Object.fromEntries(TYPES.map((t) => [t, 0]));
  for (const r of rows) out[r.t] = Number(r.premium_pct) || 0;
  return out;
}

async function premiumFor(customerId, db = { query }) {
  if (!customerId) return 0;
  const { rows: [r] } = await db.query(`SELECT COALESCE(p.premium_pct, 0) AS pct FROM customers c
    LEFT JOIN customer_type_premiums p USING (customer_type) WHERE c.customer_id = $1`, [customerId]);
  return r ? Number(r.pct) || 0 : 0;
}

// A list price with the customer's premium, to the cent.
const withPremium = (price, pct) => (price === '' || price === null || price === undefined ? price
  : Math.round(Number(price) * (1 + (Number(pct) || 0) / 100) * 100) / 100);

module.exports = { TYPE_LABEL, TYPES, premiums, premiumFor, withPremium };
