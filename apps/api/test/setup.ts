// Runs in every test worker before specs. Keeps the combined connection
// footprint of parallel workers under Postgres max_connections (100):
// per worker ≈ DB_POOL_MAX × (app pool + auth pool + boss pool) + test pools.
if (!process.env.DB_POOL_MAX) {
  process.env.DB_POOL_MAX = '3';
}
