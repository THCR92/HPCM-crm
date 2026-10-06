// Creates the HPCM tables and loads the price list into an empty database.
//   npm run db:setup     schema + full price list
//   npm run db:sample    the same, plus one sample customer and order
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

const dbDir = path.join(__dirname, '..', 'db');
const run = async (file) => {
  console.log(`Running db/${file} ...`);
  await pool.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
};

(async () => {
  const { rows } = await pool.query(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'hpcm'");
  if (rows.length) {
    console.log('The hpcm schema already exists; nothing to do.');
  } else {
    await run('schema.sql');
    await run('price_list.sql');
    if (process.argv.includes('--sample')) await run('sample_data.sql');
    console.log('Database is ready.');
  }
  await pool.end();
})().catch(async (err) => {
  console.error(err.message);
  await pool.end();
  process.exit(1);
});
