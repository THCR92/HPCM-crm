// Database connection. Set DATABASE_URL, e.g.
//   postgres://user:password@host:5432/hpcm
const { Pool, types } = require('pg');

// Return numeric/bigint columns as JS numbers (amounts stay well inside double precision).
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// Keep DATE columns as 'YYYY-MM-DD' strings so they don't shift with time zones.
types.setTypeParser(1082, (v) => v);

const connectionString = process.env.DATABASE_URL || 'postgres://hpcm:hpcm@localhost:5432/hpcm';
const pool = new Pool({
  connectionString,
  // Every connection works inside the hpcm schema (the triggers rely on it too).
  options: '-c search_path=hpcm,public',
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
