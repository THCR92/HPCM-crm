// Brings the database up to date. Safe to run on every start.
//   npm run db:setup     schema + full price list on an empty database, then updates
//   npm run db:sample    the same, plus one sample customer and order
// Updates are the files in db/migrations, run once each, in name order.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

const dbDir = path.join(__dirname, '..', 'db');
const sql = (file) => fs.readFileSync(path.join(dbDir, file), 'utf8');

async function migrate(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const files = fs.readdirSync(path.join(dbDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files.filter((f) => !done.has(f))) {
    console.log(`Applying db/migrations/${file} ...`);
    await client.query('BEGIN');
    try {
      await client.query(sql(`migrations/${file}`));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`${file}: ${err.message}`);
    }
  }
}

(async () => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'hpcm'");
    if (!rows.length) {
      for (const file of ['schema.sql', 'price_list.sql']) {
        console.log(`Running db/${file} ...`);
        await client.query(sql(file));
      }
    }
    await migrate(client);
    if (!rows.length && process.argv.includes('--sample')) {
      console.log('Running db/sample_data.sql ...');
      await client.query(sql('sample_data.sql'));
    }
    console.log('Database is up to date.');
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
