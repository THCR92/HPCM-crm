// Sending email (portal invites and password links, quote answers, ready-for-pickup
// notices). It goes out through a Gmail / Google Workspace account over SMTP, set
// on the host:
//   SMTP_USER  the Gmail address it sends from
//   SMTP_PASS  an App Password for that account (Google Account > Security > App passwords)
//   MAIL_FROM  optional, e.g. "High Plains Custom Metal <orders@example.com>"
//   SMTP_HOST / SMTP_PORT  optional, default smtp.gmail.com:465
// Quote emails can go out FROM the staff member who sends them (Tyler 2026-11-25) through
// Google Workspace's SMTP relay (smtp-relay.gmail.com, same SMTP_USER / SMTP_PASS), once
// an Admin ticks it on Admin > Email (app_settings.send_as_user). Only addresses on the
// sending account's own domain; anyone else, or a relay refusal, goes from orders@ with
// replies to them, as before. RELAY_HOST / RELAY_PORT override smtp-relay.gmail.com:587.
// Without SMTP_USER and SMTP_PASS nothing is sent and the CRM shows links to copy instead.
const { query } = require('./db');

const io = {
  transport: null,
  send: (msg) => {
    if (!io.transport) {
      const nodemailer = require('nodemailer');
      const port = Number(process.env.SMTP_PORT) || 465;
      io.transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port,
        secure: port === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
    }
    return io.transport.sendMail(msg);
  },
  relay: null,
  sendRelay: (msg) => {
    if (!io.relay) {
      const nodemailer = require('nodemailer');
      const port = Number(process.env.RELAY_PORT) || 587;
      io.relay = nodemailer.createTransport({
        host: process.env.RELAY_HOST || 'smtp-relay.gmail.com',
        port,
        secure: port === 465,
        requireTLS: port !== 465,
        // Google's relay greets by name; it wants a real hostname, not 'localhost'.
        name: 'hpcmcrm.net',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
    }
    return io.relay.sendMail(msg);
  },
  // Tests flip this on to send through a stubbed io.send.
  forceConfigured: false,
};

const configured = () => io.forceConfigured || Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
const from = () => process.env.MAIL_FROM || `High Plains Custom Metal <${process.env.SMTP_USER || 'noreply@hpcmcrm.net'}>`;

const SIGNATURE = '\n\nThank you,\nHigh Plains Custom Metal\n805 E Fox Farm Rd Unit B, Cheyenne, WY 82007\n(307) 331-6449';

// The domain staff can send as: the sending account's own (orders@ -> its domain).
const ownDomain = () => {
  const m = String(process.env.MAIL_FROM || process.env.SMTP_USER || '').match(/@([^>\s]+)/);
  return m ? m[1].toLowerCase() : null;
};
async function sendAsOn() {
  const { rows: [r] } = await query("SELECT value FROM app_settings WHERE key = 'send_as_user'").catch(() => ({ rows: [] }));
  return Boolean(r && r.value === 'true');
}
// Whether a quote this person sends will go out from their own address.
async function sendsAs(email) {
  const d = ownDomain();
  return Boolean(d && email && String(email).toLowerCase().endsWith(`@${d}`) && (await sendAsOn()));
}

// Sends one plain-text email and logs it. Returns true if it went; never throws.
// asUser {name, email}: send from that person when Admin > Email allows it (see top).
async function send({ to, cc, subject, text, kind = null, orderId = null, replyTo, attachments, signature = true, asUser }) {
  if (!configured() || !to) return false;
  let error = null;
  let note = null;
  const msg = { to, subject, text: signature ? text + SIGNATURE : text,
    ...(cc ? { cc } : {}), ...(attachments ? { attachments } : {}) };
  let done = false;
  if (asUser && (await sendsAs(asUser.email))) {
    const name = String(asUser.name || '').replace(/["<>]/g, '');
    try {
      await io.sendRelay({ ...msg, from: name ? `"${name}" <${asUser.email}>` : asUser.email });
      done = true;
    } catch (err) {
      note = `Sent from ${process.env.SMTP_USER || 'the CRM'} instead: Google's relay refused ${asUser.email} (${String(err.message || err).slice(0, 300)})`;
      console.error('Relay send failed, using the CRM address:', note);
    }
  }
  if (!done) {
    try {
      await io.send({ ...msg, from: from(), ...(replyTo ? { replyTo } : {}) });
    } catch (err) {
      error = String(err.message || err).slice(0, 500);
      console.error('Email failed:', subject, error);
    }
  }
  await query(`INSERT INTO email_log (to_address, subject, kind, order_id, ok, error) VALUES ($1, $2, $3, $4, $5, $6)`,
    [[to, cc].flat().filter(Boolean).join(', '), subject, kind, orderId, !error, error || note]).catch(() => {});
  return !error;
}

// Admins and Managers: who hears about quotes customers answer in the portal.
async function managers() {
  const { rows } = await query("SELECT email FROM users WHERE active AND role IN ('admin', 'manager') ORDER BY user_id");
  return rows.map((r) => r.email);
}

module.exports = { io, configured, send, managers, sendsAs, sendAsOn, ownDomain };
