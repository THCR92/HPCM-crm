const path = require('path');
const express = require('express');

const app = express();
app.disable('x-powered-by');

// Health check for the hosting service; answers without signing in.
app.get('/healthz', (req, res) => res.send(`ok ${(process.env.RENDER_GIT_COMMIT || '').slice(0, 7)}`.trim()));

// Render sits in front of the app; trust it so secure cookies work.
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '1mb' }));

// Everyone signs in with their own account (see src/auth.js).
app.use(require('./auth').middleware());
app.use('/', require('./routes/users'));

app.get('/', (req, res) => res.redirect('/orders'));
app.use('/orders', require('./routes/orders'));
app.use('/customers', require('./routes/customers'));
app.use('/board', require('./routes/board'));
app.use('/', require('./routes/admin'));
app.use('/', require('./routes/catalog'));
app.use('/', require('./routes/inventory'));

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
