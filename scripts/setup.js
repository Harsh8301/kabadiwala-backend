const fs = require('node:fs');
const crypto = require('node:crypto');
const { pool, passwordHash } = require('../lib/marketplace');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await pool.query(fs.readFileSync(require('node:path').join(__dirname,'../schema.sql'),'utf8'));
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must have at least 12 characters');
    await pool.query(`INSERT INTO users(id,email,password_hash,role,name)
      VALUES($1,$2,$3,'ADMIN','Administrator') ON CONFLICT(email) DO NOTHING`,
      [crypto.randomUUID(),process.env.ADMIN_EMAIL.toLowerCase(),passwordHash(process.env.ADMIN_PASSWORD)]);
  }
  console.log('Database schema ready');
  await pool.end();
}
main().catch((error) => { console.error(error); process.exitCode=1; pool.end(); });
