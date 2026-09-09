'use strict';

const { Pool } = require('pg');

// Homebrew PG16 on 5433 with trust auth. The EDB PG17 instance on the default
// 5432 is password-locked and deliberately left alone.
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://nishantgada@localhost:5433/smart_receipt',
  max: 10,
});

// Every item name is keyed through this one SQL expression, in both reads and
// writes, so the JS side can never disagree with the generated columns about
// what counts as the same item. Case and surrounding whitespace fold together;
// nothing else does.
const NAME_KEY_SQL = `lower(btrim(regexp_replace($NAME$, '\\s+', ' ', 'g')))`;
const nameKeyExpr = (placeholder) => NAME_KEY_SQL.replace('$NAME$', placeholder);

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

module.exports = { pool, query, tx, nameKeyExpr };
