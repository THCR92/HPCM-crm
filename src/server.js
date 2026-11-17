const path = require('path');
const express = require('express');
const alerts = require('./alerts');

const app = express();
app.disable('x-powered-by');

// Health check for the hosting service; answers without signing in.
app.get('/healthz', (req, res) => res.send(`ok ${(process.env.RENDER_GIT_COMMIT || '').slice(0, 7)}`.trim()));

// Render sits in front of the app; trust it so secure cookies work.
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, '..', 'public')));
// pdf.js draws line drawings (PDFs) into the cut sheet so they print.
app.use('/vendor/pdfjs', express.static(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build')));

// QuickBooks webhooks: no sign-in, and the raw body is needed to check QuickBooks' signature.
const qbo = require('./qbo');
app.post('/qbo/webhook', express.raw({ type: () => true, limit: '1mb' }), (req, res, next) => {
  qbo.handleWebhook(req.body || Buffer.alloc(0), req.get('intuit-signature'))
    .then((ok) => res.status(ok ? 200 : 401).end(), next);
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '1mb' }));

// Everyone signs in with their own account (see src/auth.js).
// Customers sign in to the portal with their own logins (not staff accounts).
app.use('/', require('./routes/portal'));
app.use(require('./auth').middleware());
app.use('/', require('./routes/users'));
app.use('/', require('./routes/legal'));

app.get('/', (req, res) => res.redirect('/orders'));
app.use('/orders', require('./routes/orders'));
app.use('/customers', require('./routes/customers'));
app.use('/board', require('./routes/board'));
app.use('/', require('./routes/reports'));
app.use('/', require('./routes/supplies'));
app.use('/', require('./routes/countsheets'));
app.use('/', require('./routes/labels'));
app.use('/', require('./routes/qbo'));
app.use('/', require('./routes/admin'));
app.use('/', require('./routes/catalog'));
app.use('/', require('./routes/inventory'));
app.use('/', require('./routes/flatsheets'));
app.use('/', require('./routes/shop'));

app.use((req, res) => res.status(404).send('Page not found'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  alerts.pageError(err, req);
  res.status(500).send('Something went wrong. The details are in the server log.');
});

const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`HPCM CRM running at http://localhost:${port}`));
  // Anything that escapes every handler: email the Admins. A crash restarts the site
  // (Render starts it again), so give the email a few seconds to go first.
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled:', err);
    alerts.alert(`unhandled:${String(err && err.message).slice(0, 80)}`, 'something failed in the background', [
      'Something the CRM was doing in the background failed.', '', `Error: ${String(err && (err.stack || err.message) || err).slice(0, 1500)}`]);
  });
  process.on('uncaughtException', (err) => {
    console.error('Crashed:', err);
    const done = () => process.exit(1);
    setTimeout(done, 8000).unref();
    alerts.alert('crash', 'the site crashed and restarted', [
      'The CRM stopped with an error. Render starts it again on its own, but this shouldn\'t happen.', '',
      `Error: ${String(err && (err.stack || err.message) || err).slice(0, 1500)}`]).finally(done);
  });
  qbo.startChecks();
}

module.exports = app;
