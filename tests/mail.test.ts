/**
 * The mailer, and the one thing it is for: a sign-in link must never reach a log.
 *
 * Both applications printed them to the server console. That is correct locally and a
 * credential leak in a deployment, so the rule the tests below pin is that the console
 * driver cannot exist in production and that an unconfigured mailer prints nothing of
 * the body rather than falling back to printing it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  mailConfigured, mailDriver, mailMisconfiguration, sendMail, type MailEnv,
} from '../src/mail';

const LINK = 'https://example.com/invite/SECRET-TOKEN-VALUE';
const mail = { to: 'someone@example.com', subject: 'Your sign-in link', text: LINK };

function captureConsole() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.map(String).join(' '));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('which driver an environment resolves to', () => {
  it('prints locally when nothing is configured', () => {
    expect(mailDriver({ NODE_ENV: 'development' })).toBe('console');
    expect(mailConfigured({ NODE_ENV: 'development' })).toBe(true);
  });

  it('refuses to print in production, however it is asked', () => {
    expect(mailDriver({ NODE_ENV: 'production' })).toBe('none');
    expect(mailDriver({ NODE_ENV: 'production', MAIL_DRIVER: 'console' })).toBe('none');
    expect(mailConfigured({ NODE_ENV: 'production' })).toBe(false);
  });

  it('uses Resend when a key and a verified sender are both present', () => {
    const env: MailEnv = {
      NODE_ENV: 'production', RESEND_API_KEY: 'k', MAIL_FROM: 'care@example.com',
    };
    expect(mailDriver(env)).toBe('resend');
    expect(mailConfigured(env)).toBe(true);
  });

  it('is not configured with a key and no sender, and says which is missing', () => {
    const env: MailEnv = { NODE_ENV: 'production', RESEND_API_KEY: 'k' };
    expect(mailConfigured(env)).toBe(false);
    expect(mailMisconfiguration(env)).toMatch(/MAIL_FROM/);
  });

  it('a driver name this build does not have is not quietly ignored', () => {
    const env: MailEnv = { NODE_ENV: 'production', MAIL_DRIVER: 'sendgrid' };
    expect(mailDriver(env)).toBe('none');
    expect(mailMisconfiguration(env)).toMatch(/sendgrid/);
  });
});

describe('an unconfigured production mailer', () => {
  it('prints nothing at all, and does not leak the body into the reason', async () => {
    const captured = captureConsole();
    try {
      const outcome = await sendMail(mail, { NODE_ENV: 'production' });
      expect(outcome.delivered).toBe(false);
      expect(captured.lines.join('\n')).not.toContain('SECRET-TOKEN-VALUE');
      expect(captured.lines).toHaveLength(0);
      expect(JSON.stringify(outcome)).not.toContain('SECRET-TOKEN-VALUE');
    } finally {
      captured.restore();
    }
  });

  it('a provider refusal reports the status and not the message it refused', async () => {
    const refuse = vi.fn(async () => new Response(
      JSON.stringify({ message: `Invalid recipient for ${LINK}` }), { status: 422 },
    ));
    const outcome = await sendMail(
      mail,
      { NODE_ENV: 'production', RESEND_API_KEY: 'k', MAIL_FROM: 'care@example.com' },
      refuse as unknown as typeof fetch,
    );
    expect(outcome.delivered).toBe(false);
    expect(JSON.stringify(outcome)).toContain('422');
    expect(JSON.stringify(outcome)).not.toContain('SECRET-TOKEN-VALUE');
  });

  it('an unreachable provider is a failure, not an exception', async () => {
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const outcome = await sendMail(
      mail,
      { NODE_ENV: 'production', RESEND_API_KEY: 'k', MAIL_FROM: 'care@example.com' },
      down as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ delivered: false, reason: 'The mail provider could not be reached.' });
  });
});

describe('sending', () => {
  it('prints the whole message locally, because there is nowhere else for it to go', async () => {
    const captured = captureConsole();
    try {
      const outcome = await sendMail(mail, { NODE_ENV: 'development' });
      expect(outcome).toEqual({ delivered: true, via: 'console' });
      expect(captured.lines.join('\n')).toContain(LINK);
    } finally {
      captured.restore();
    }
  });

  it('posts one plain-text message to Resend, from the verified sender', async () => {
    const sent = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
    const outcome = await sendMail(
      mail,
      {
        NODE_ENV: 'production', RESEND_API_KEY: 'key-123',
        MAIL_FROM: 'care@example.com', MAIL_REPLY_TO: 'reply@example.com',
      },
      sent as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ delivered: true, via: 'resend' });

    const [url, init] = sent.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key-123');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      from: 'care@example.com',
      to: ['someone@example.com'],
      subject: 'Your sign-in link',
      text: LINK,
      reply_to: 'reply@example.com',
    });
    // No HTML part. A link in an HTML mail is a link a client can rewrite or prefetch,
    // and a prefetched single-use sign-in link is a consumed one.
    expect(body.html).toBeUndefined();
  });

  it('refuses something that is not an address without calling the provider', async () => {
    const never = vi.fn();
    const outcome = await sendMail(
      { ...mail, to: 'not-an-address' },
      { NODE_ENV: 'production', RESEND_API_KEY: 'k', MAIL_FROM: 'care@example.com' },
      never as unknown as typeof fetch,
    );
    expect(outcome.delivered).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });
});
