/**
 * The production database guard.
 *
 * This exists because of a real incident: the console deployed with no DATABASE_URL,
 * silently fell back to embedded PGlite on a read-only serverless filesystem, and the
 * only symptom was a 500 on /login/verify — three clicks from the cause, on the one route
 * that happened to touch the database first.
 */
import { describe, expect, it } from 'vitest';
import {
  ConfigError, describeConnection, resolveDatabaseConfig, resolveMigrationConfig,
} from '../src/env';

const REMOTE = 'postgres://u:secret@db.example.com:5432/ccn?sslmode=require';
const POOLED = 'postgres://u:secret@db.example.com:6543/ccn?sslmode=require';

describe('resolveDatabaseConfig', () => {
  it('uses DATABASE_URL whenever one is set', () => {
    expect(resolveDatabaseConfig({ NODE_ENV: 'production', DATABASE_URL: REMOTE }))
      .toEqual({ driver: 'postgres', url: REMOTE });
  });

  it('falls back to the embedded database in development', () => {
    expect(resolveDatabaseConfig({ NODE_ENV: 'development' })).toEqual({ driver: 'pglite' });
    expect(resolveDatabaseConfig({ NODE_ENV: 'test' })).toEqual({ driver: 'pglite' });
  });

  it('refuses to fall back in production', () => {
    expect(() => resolveDatabaseConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
  });

  it('treats an empty or whitespace DATABASE_URL as unset', () => {
    expect(() => resolveDatabaseConfig({ NODE_ENV: 'production', DATABASE_URL: '   ' }))
      .toThrow(ConfigError);
    expect(resolveDatabaseConfig({ NODE_ENV: 'development', DATABASE_URL: '' }))
      .toEqual({ driver: 'pglite' });
  });

  it('names what to set, so the message is actionable from a log line alone', () => {
    try {
      resolveDatabaseConfig({ NODE_ENV: 'production' });
      throw new Error('expected a ConfigError');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('npm run db:deploy');
    }
  });

  it('offers no escape hatch — a flag to re-enable the fallback would be set once and forgotten', () => {
    expect(() => resolveDatabaseConfig({
      NODE_ENV: 'production',
      ...{ ALLOW_EMBEDDED_DB: '1', PGLITE_DIR: '/tmp/x' },
    } as never)).toThrow(ConfigError);
  });
});

describe('Vercel marketplace variables', () => {
  it('uses POSTGRES_URL when DATABASE_URL is absent', () => {
    expect(resolveDatabaseConfig({ NODE_ENV: 'production', POSTGRES_URL: POOLED }))
      .toEqual({ driver: 'postgres', url: POOLED });
  });

  it('prefers an explicit DATABASE_URL over the injected one', () => {
    expect(resolveDatabaseConfig({ DATABASE_URL: REMOTE, POSTGRES_URL: POOLED }))
      .toEqual({ driver: 'postgres', url: REMOTE });
  });

  it('finds the unpooled connection under either injected name', () => {
    expect(resolveMigrationConfig({ POSTGRES_URL: POOLED, DATABASE_URL_UNPOOLED: REMOTE }))
      .toEqual({ driver: 'postgres', url: REMOTE });
    expect(resolveMigrationConfig({ POSTGRES_URL: POOLED, POSTGRES_URL_NON_POOLING: REMOTE }))
      .toEqual({ driver: 'postgres', url: REMOTE });
  });

  it('prefers an explicit DIRECT_URL over the injected ones', () => {
    expect(resolveMigrationConfig({
      DIRECT_URL: REMOTE, DATABASE_URL_UNPOOLED: POOLED, POSTGRES_URL_NON_POOLING: POOLED,
    })).toEqual({ driver: 'postgres', url: REMOTE });
  });
});

describe('migrating through a pooler is refused', () => {
  it('rejects a transaction pooler on port 6543', () => {
    expect(() => resolveMigrationConfig({ DATABASE_URL: POOLED }))
      .toThrow(/pooled|CREATE TRIGGER/i);
  });

  it('rejects a host that announces itself as a pooler', () => {
    expect(() => resolveMigrationConfig({
      DATABASE_URL: 'postgres://u:p@aws-0-us-west-1.pooler.supabase.com:5432/postgres',
    })).toThrow(/pooled/i);
  });

  it('rejects a pgbouncer query flag', () => {
    expect(() => resolveMigrationConfig({
      DATABASE_URL: 'postgres://u:p@db.example.com:5432/ccn?pgbouncer=true',
    })).toThrow(/pooled/i);
  });

  it('allows a plain direct connection as the only URL, which is the local case', () => {
    expect(resolveMigrationConfig({ DATABASE_URL: REMOTE }))
      .toEqual({ driver: 'postgres', url: REMOTE });
  });

  it('names the host but never the password when it refuses', () => {
    try {
      resolveMigrationConfig({ DATABASE_URL: POOLED });
      throw new Error('expected a ConfigError');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('db.example.com:6543');
      expect(message).not.toContain('secret');
    }
  });
});

describe('resolveMigrationConfig', () => {
  it('prefers DIRECT_URL, because a pooler cannot run migration 0001', () => {
    expect(resolveMigrationConfig({ DATABASE_URL: POOLED, DIRECT_URL: REMOTE }))
      .toEqual({ driver: 'postgres', url: REMOTE });
  });

  it('falls back to DATABASE_URL when it is not itself a pooler', () => {
    expect(resolveMigrationConfig({ DATABASE_URL: REMOTE }))
      .toEqual({ driver: 'postgres', url: REMOTE });
  });

  it('applies the same production rule', () => {
    expect(() => resolveMigrationConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(resolveMigrationConfig({ NODE_ENV: 'development' })).toEqual({ driver: 'pglite' });
  });
});

describe('describeConnection', () => {
  it('names the host and database and never the password', () => {
    const described = describeConnection(REMOTE);
    expect(described).toBe('db.example.com:5432/ccn');
    expect(described).not.toContain('secret');
    expect(described).not.toContain('u:');
  });

  it('does not throw on a malformed connection string', () => {
    expect(describeConnection('not a url')).toBe('an unparseable connection string');
  });
});
