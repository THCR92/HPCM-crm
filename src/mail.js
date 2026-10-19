// Sending email (portal invites and password links, quote answers, ready-for-pickup
// notices). It goes out through a Gmail / Google Workspace account over SMTP, set
// on the host:
//   SMTP_USER  the Gmail address it sends from
//   SMTP_PASS  an App Password for that account (Google Account > Security > App passwords)
//   MAIL_FROM  optional, e.g. "High Plains Custom Metal <orders@example.com>"
//   SMTP_HOST / SMTP_PORT  optional, default smtp.gmail.com:465
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
  // Tests flip this on to send through a stubbed io.send.
  forceConfigured: false,
};

const configured = () => io.forceConfigured || Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
const from = () => process.env.MAIL_FROM || `High Plains Custom Metal <${process.env.SMTP_USER || 'noreply@hpcmcrm.net'}>`;

const SIGNATURE = '\n\nThank you,\nHigh Plains Custom Metal\n805 E Fox Farm Rd Unit B, Cheyenne, WY 82007\n(307) 331-6449';

// Sends one plain-text email and logs it. Returns true if it went; never throws.
async function send({ to, subject, text, kind = null, orderId = null, replyTo }) {
  if (!configured() || !to) return false;
  let error = null;
  try {
    await io.send({ from: from(), to, subject, text: text + SIGNATURE, ...(replyTo ? { replyTo } : {}) });
  } catch (err) {
    error = String(err.message || err).slice(0, 500);
    console.error('Email failed:', subject, error);
  }
  await query(`INSERT INTO email_log (to_address, subject, kind, order_id, ok, error) VALUES ($1, $2, $3, $4, $5, $6)`,
    [Array.isArray(to) ? to.join(', ') : to, subject, kind, orderId, !error, error]).catch(() => {});
  return !error;
}

// Admins and Managers: who hears about quotes customers answer in the portal.
async function managers() {
  const { rows } = await query("SELECT email FROM users WHERE active AND role IN ('admin', 'manager') ORDER BY user_id");
  return rows.map((r) => r.email);
}

module.exports = { io, configured, send, managers };
