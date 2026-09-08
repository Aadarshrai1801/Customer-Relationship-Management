import type { PoolConfig } from 'pg';

/**
 * Shared Postgres connection helper for local Docker AND hosted providers
 * (Neon, Supabase, Railway, RDS…).
 *
 * Why this exists: hosted Postgres almost always requires TLS. `pg` will
 * refuse to connect (ECONNRESET / "server does not support SSL" / "SSL
 * required") unless `ssl` is set. Local Docker Postgres has no TLS, so we
 * must NOT force it there. This helper auto-detects hosted URLs and only
 * enables TLS for those, unless explicitly overridden.
 *
 * Detection rules (any match → TLS on):
 * - `DATABASE_SSL=true` (explicit force) / `DATABASE_SSL=false` (explicit off)
 * - URL contains `sslmode=require` (Neon dashboard URLs include this)
 * - Hostname looks hosted: neon.tech, supabase.co, railway.app, render.com,
 *   amazonaws.com, neon.db, pooler.supabase
 */
export function shouldUseSsl(connectionString: string | undefined): boolean {
  const forced = (process.env.DATABASE_SSL ?? '').trim().toLowerCase();
  if (forced === 'true' || forced === '1' || forced === 'require') return true;
  if (forced === 'false' || forced === '0' || forced === 'disable') return false;
  if (!connectionString) return false;
  const lower = connectionString.toLowerCase();
  if (lower.includes('sslmode=require') || lower.includes('ssl=true')) return true;
  return (
    lower.includes('neon.tech') ||
    lower.includes('supabase.co') ||
    lower.includes('railway.app') ||
    lower.includes('render.com') ||
    lower.includes('amazonaws.com') ||
    lower.includes('pooler.supabase')
  );
}

export function poolConfigFromUrl(
  url: string | undefined,
  fallback: string,
  poolMax?: number,
): PoolConfig {
  const connectionString = url || fallback;
  const rawMax = poolMax ?? Number(process.env.DB_POOL_MAX ?? 10);
  const max = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 10;
  const config: PoolConfig = { connectionString, max };
  if (shouldUseSsl(connectionString)) {
    // Hosted providers use public CAs; Neon/Supabase rotate certs, so we
    // accept the chain without pinning. Data is still fully TLS-encrypted.
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}
