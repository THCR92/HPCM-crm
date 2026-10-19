// Emails the CRM sends on its own (see src/mail.js for how sending is set up).
const { query } = require('./db');
const mail = require('./mail');

const site = () => (process.env.PUBLIC_URL || 'https://www.hpcmcrm.net').replace(/\/$/, '');

// A customer approved or declined a quote in the portal: tell the Admins and Managers.
async function quoteAnswered(orderId) {
  const { rows: [o] } = await query(`
    SELECT o.order_number, o.job_name, o.customer_decision, o.customer_decided_by, o.customer_decision_note,
           o.need_by, c.display_name FROM orders o JOIN customers c USING (customer_id) WHERE o.order_id = $1`, [orderId]);
  if (!o || !o.customer_decision) return;
  const verb = o.customer_decision === 'approved' ? 'approved' : 'declined';
  const text = [
    `${o.display_name} ${verb} quote ${o.order_number}${o.job_name ? ` (${o.job_name})` : ''} in the customer portal.`,
    `By: ${o.customer_decided_by}`,
    ...(o.customer_decision_note ? [`Their note: ${o.customer_decision_note}`] : []),
    ...(o.customer_decision === 'approved' ? [`Need by: ${o.need_by || 'not given'}`, '',
      'It still needs your approval: check it, then change its status to Confirmed.'] : []),
    '', `${site()}/orders/${orderId}`,
  ].join('\n');
  await mail.send({ to: await mail.managers(), subject: `Quote ${o.order_number} ${verb} by ${o.display_name}`, text, kind: `quote_${verb}`, orderId });
}

// A customer wrote a quote in the portal.
async function quoteCreated(orderId) {
  const { rows: [o] } = await query(`
    SELECT o.order_number, o.job_name, o.created_by, o.internal_notes, c.display_name
    FROM orders o JOIN customers c USING (customer_id) WHERE o.order_id = $1`, [orderId]);
  if (!o) return;
  const text = [
    `${o.display_name} started quote ${o.order_number}${o.job_name ? ` (${o.job_name})` : ''} in the customer portal (${o.created_by}).`,
    ...(o.internal_notes ? [o.internal_notes] : []),
    '', 'It is priced from the price list. They can approve it from the portal; check it when they do.',
    '', `${site()}/orders/${orderId}`,
  ].join('\n');
  await mail.send({ to: await mail.managers(), subject: `New quote ${o.order_number} from ${o.display_name}`, text, kind: 'quote_created', orderId });
}

// An order is packed and ready: tell the customer (their portal login, or the order's email).
async function orderReady(orderId) {
  const { rows: [o] } = await query(`
    SELECT o.order_number, o.job_name, o.po_number, o.fulfillment, o.contact_email, c.email AS customer_email,
           c.portal_enabled, l.email AS login_email, l.full_name AS login_name
    FROM orders o JOIN customers c USING (customer_id)
    LEFT JOIN customer_logins l ON l.customer_id = c.customer_id AND l.active AND l.password_hash IS NOT NULL
    WHERE o.order_id = $1`, [orderId]);
  if (!o) return;
  const portal = o.portal_enabled && o.login_email;
  const to = portal ? o.login_email : o.contact_email || o.customer_email;
  if (!to) return;
  const what = `order ${o.order_number}${o.job_name ? ` (${o.job_name})` : ''}${o.po_number ? `, PO ${o.po_number}` : ''}`;
  const text = [
    `Hello${portal ? ` ${o.login_name.split(' ')[0]}` : ''},`, '',
    o.fulfillment === 'delivery'
      ? `Your ${what} is ready, and we'll be in touch to set up delivery.`
      : `Your ${what} is ready for pickup at our shop, 805 E Fox Farm Rd Unit B, Cheyenne.`,
    ...(portal ? ['', `See the order here: ${site()}/portal/orders/${orderId}`] : []),
  ].join('\n');
  await mail.send({ to, subject: `${o.order_number} is ready${o.fulfillment === 'delivery' ? '' : ' for pickup'}`, text, kind: 'order_ready', orderId });
}

// A link for a customer login to set its password (first invite or a reset).
async function passwordLink(login, url, { reset = false } = {}) {
  const text = reset
    ? [`Hello ${login.full_name.split(' ')[0]},`, '', 'Here is your link to set a new password for your High Plains Custom Metal customer login.',
      'It works once, for 14 days:', '', url, '', "If you didn't ask for this, you can ignore it."].join('\n')
    : [`Hello ${login.full_name.split(' ')[0]},`, '',
      'You can now see your quotes and orders with High Plains Custom Metal online, and approve quotes there.',
      'Open this link to set your password (it works for 14 days):', '', url, '',
      `After that, sign in any time at ${site()}/portal`].join('\n');
  return mail.send({ to: login.email, subject: reset ? 'Reset your High Plains Custom Metal password' : 'Your High Plains Custom Metal customer login', text, kind: reset ? 'password_reset' : 'invite' });
}

// Fire and forget: a failed email never stops the page.
const later = (fn) => (...args) => { fn(...args).catch((err) => console.error('Notice failed:', err.message)); };

module.exports = {
  quoteAnswered: later(quoteAnswered), quoteCreated: later(quoteCreated), orderReady: later(orderReady), passwordLink,
  now: { quoteAnswered, quoteCreated, orderReady },
};
