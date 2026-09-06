/**
 * One-time installer for the pg-boss schema. Runs with the migration
 * (superuser) connection because it performs DDL; the runtime uses the
 * least-privilege app role against the pre-created `boss` schema.
 *
 * Usage: npm run queue:install -w @nexus/api
 */
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { PgBoss } = require('pg-boss');

function loadEnv() {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

async function main() {
  loadEnv();
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) throw new Error('MIGRATE_DATABASE_URL is not set');
  const boss = new PgBoss({ connectionString: url, schema: 'boss' });
  boss.on('error', (err) => {
    console.error('queue installer error', err);
    process.exitCode = 1;
  });
  await boss.start();
  await boss.stop();
  console.log('queue schema ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
