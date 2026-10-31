/**
 * Environment guards.
 *
 * The embedded PGlite database is right for local development and wrong everywhere else.
 * On a serverless host the filesystem is read-only outside /tmp, and even where it is
 * writable every invocation gets its own container — so each request would get its own
 * empty database, sessions would never survive, and the symptom would be an unexplained
 * 500 several clicks away from the cause.
 *
 * Falling back silently is the failure mode worth preventing, so a production build with
 * no DATABASE_URL refuses to connect at all and says exactly what to set.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface EnvLike {
  NODE_ENV?: string | undefined;
  DATABASE_URL?: string | undefined;
  DIRECT_URL?: string | undefined;
  // Injected automatically when the database is provisioned through the Vercel
  // marketplace. Reading them means a correct deployment needs nothing set by hand,
  // and nobody has to know which of these is the pooled one.
  POSTGRES_URL?: string | undefined;
  DATABASE_URL_UNPOOLED?: string | undefined;
  POSTGRES_URL_NON_POOLING?: string | undefined;
}

/** In order of preference. The first non-empty one wins. */
const POOLED_KEYS = ['DATABASE_URL', 'POSTGRES_URL'] as const;
const DIRECT_KEYS = [
  'DIRECT_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING',
] as const;

function firstSet(env: EnvLike, keys: readonly (keyof EnvLike)[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export type DatabaseConfig =
  | { driver: 'postgres'; url: string }
  | { driver: 'pglite' };

const SETUP_HINT =
  'Set DATABASE_URL to a real Postgres 16 (include ?sslmode=require), then apply the '
  + 'schema from a machine that can reach it:\n'
  + '  npm run db:deploy';

/**
 * The connection the running application uses. Architecture spec § 7 calls this the
 * pooled URL.
 *
 * Pure, so the rule is testable without a database and without mutating the real process
 * environment.
 */
export function resolveDatabaseConfig(env: EnvLike): DatabaseConfig {
  const url = firstSet(env, POOLED_KEYS);
  if (url) return { driver: 'postgres', url };

  if (isProduction(env)) {
    throw new ConfigError(
      'DATABASE_URL is not set, and this is a production build.\n\n'
      + 'The embedded PGlite database is for local development only. On a serverless host '
      + 'it cannot persist: the filesystem is read-only, and every invocation gets its own '
      + 'container, so sessions and records would vanish between requests.\n\n'
      + SETUP_HINT,
    );
  }

  return { driver: 'pglite' };
}

/**
 * The connection migrations run over. Architecture spec § 7 keeps this separate as
 * DIRECT_URL, and the distinction is load-bearing rather than cosmetic: a pooled
 * connection in transaction mode (pgbouncer, Supabase's 6543 port, Neon's pooler) cannot
 * run the CREATE TYPE, CREATE FUNCTION and CREATE TRIGGER statements in migration 0001.
 * Point DIRECT_URL at the unpooled host.
 */
export function resolveMigrationConfig(env: EnvLike): DatabaseConfig {
  const direct = firstSet(env, DIRECT_KEYS);
  if (direct) return { driver: 'postgres', url: direct };

  // No direct connection given. Falling back to the pooled one is right for a local
  // Postgres, where they are the same thing, and wrong for a managed one — so say so
  // rather than failing later with a syntax error on CREATE TRIGGER.
  const pooled = resolveDatabaseConfig(env);
  if (pooled.driver === 'postgres' && looksPooled(pooled.url)) {
    throw new ConfigError(
      `The only connection available looks like a pooled one (${describeConnection(pooled.url)}).\n\n`
      + 'Migration 0001 contains CREATE TYPE, CREATE FUNCTION and CREATE TRIGGER '
      + 'statements, and a pooler in transaction mode cannot execute them.\n\n'
      + 'Set DIRECT_URL to the unpooled connection — on Supabase that is the session '
      + 'pooler or direct connection on port 5432, not the transaction pooler on 6543.',
    );
  }
  return pooled;
}

/** Transaction-mode poolers announce themselves by port or hostname. */
function looksPooled(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.port === '6543' || /\bpooler\b|\bpgbouncer\b/.test(parsed.hostname)
      || /[?&]pgbouncer=true/.test(url);
  } catch {
    return false;
  }
}

function isProduction(env: EnvLike): boolean {
  return env.NODE_ENV === 'production';
}

/** Host and database only. Never the password, and never logged in full. */
/**
 * Which connection variables are present, by name only — never a value.
 *
 * The names are already public in this repository, and when a deployment reports
 * "not configured" the next question is always whether the variable is missing or
 * whether the deployment predates it. This answers that without a Vercel login.
 */
export function describeEnvPresence(env: EnvLike): Record<string, boolean> {
  const keys = [...POOLED_KEYS, ...DIRECT_KEYS] as readonly (keyof EnvLike)[];
  return Object.fromEntries(keys.map((k) => [k, Boolean(env[k]?.trim())]));
}

export function describeConnection(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
  } catch {
    return 'an unparseable connection string';
  }
}
