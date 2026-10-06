const path = require('path');
const crypto = require('crypto');
const express = require('express');

const app = express();
app.disable('x-powered-by');

// Optional sign-in: set APP_PASSWORD (and optionally APP_USER) once the app is online.
const { APP_USER = 'hpcm', APP_PASSWORD } = process.env;
if (APP_PASSWORD) {
  const expected = Buffer.from(`${APP_USER}:${APP_PASSWORD}`);
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const given = Buffer.from(scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString() : '');
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="HPCM CRM"').status(401).send('Sign in required');
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => res.redirect('/orders'));
app.use('/orders', require('./routes/orders'));
app.use('/customers', require('./routes/customers'));
app.use('/', require('./routes/catalog'));

app.use((req, res) => res.status(404).send('Page not found'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. The details are in the server log.');
});

const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`HPCM CRM running at http://localhost:${port}`));
}

module.exports = app;
