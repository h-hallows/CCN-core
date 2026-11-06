/**
 * Sending mail. One implementation, because both applications send the same two things:
 * a sign-in link, and a notification about one.
 *
 * WHY THIS EXISTS, AND WHY IT FAILS CLOSED.
 *
 * Both applications printed sign-in links to the server console. Locally that is the
 * right behaviour and there is nowhere else for them to go. In a deployment it means
 * anyone who can read function logs — a platform collaborator, a log drain, an
 * aggregator with a wide retention window — can sign in as a permitted operator, or as
 * any family, by copying a line out of them. A magic link is a bearer credential with a
 * fifteen-minute life, and a log is not a place to put one.
 *
 * So: the console driver exists only outside production. In production, an unconfigured
 * mailer returns `{ delivered: false }` and prints nothing of the body. The caller is
 * then obliged to say that signing in is unavailable, which is true, rather than to say
 * a link was sent, which would not be.
 *
 * WHAT A CALLER MUST NOT DO WITH THE RESULT. On a public form, decide whether the mailer
 * is configured BEFORE looking the address up — `mailConfigured()` is there for exactly
 * that. A configuration failure is the same for every address; a delivery failure is not,
 * and branching on one tells an unauthenticated visitor whether an address is known.
 */

export interface Mail {
  to: string;
  subject: string;
  /** Plain text. There is no template engine here and there should not be one. */
  text: string;
}

export type MailOutcome =
  | { delivered: true; via: 'resend' | 'console' }
  | { delivered: false; reason: string };

export interface MailEnv {
  NODE_ENV?: string | undefined;
  /** 'resend' or 'console'. Unset means resend when a key is present, else console. */
  MAIL_DRIVER?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  /** The From header. Resend refuses a domain it has not verified. */
  MAIL_FROM?: string | undefined;
  MAIL_REPLY_TO?: string | undefined;
}

export type MailDriver = 'resend' | 'console' | 'none';

function isProduction(env: MailEnv): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Which driver this environment resolves to. 'none' means nothing can be sent, which in
 * production is a misconfiguration and outside it never happens.
 */
export function mailDriver(env: MailEnv = process.env): MailDriver {
  const named = env.MAIL_DRIVER?.trim().toLowerCase();

  if (named === 'resend') return env.RESEND_API_KEY?.trim() ? 'resend' : 'none';
  if (named === 'console') return isProduction(env) ? 'none' : 'console';
  if (named && named !== '') return 'none';

  if (env.RESEND_API_KEY?.trim()) return 'resend';
  return isProduction(env) ? 'none' : 'console';
}

/** Whether anything can be sent at all. Address-independent, by construction. */
export function mailConfigured(env: MailEnv = process.env): boolean {
  if (mailDriver(env) === 'none') return false;
  // A verified sender is as necessary as the key: Resend rejects the send without one,
  // and finding that out per-recipient at send time is the slow way to learn it.
  if (mailDriver(env) === 'resend') return Boolean(env.MAIL_FROM?.trim());
  return true;
}

/**
 * What to tell the operator when it is not. Returned rather than thrown, because the one
 * place this matters is a sign-in page, and a stack trace is not an answer for a person
 * trying to get into their own tool.
 */
export function mailMisconfiguration(env: MailEnv = process.env): string | null {
  if (mailConfigured(env)) return null;
  if (mailDriver(env) === 'resend' || env.RESEND_API_KEY?.trim()) {
    return 'MAIL_FROM is not set, so there is no verified sender to send from.';
  }
  if (env.MAIL_DRIVER?.trim() && mailDriver(env) === 'none') {
    return `MAIL_DRIVER is set to "${env.MAIL_DRIVER.trim()}", which is not a driver this build has.`;
  }
  return 'No mail provider is configured. Set RESEND_API_KEY and MAIL_FROM.';
}

export async function sendMail(
  mail: Mail,
  env: MailEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<MailOutcome> {
  const to = mail.to.trim();
  if (!to.includes('@')) return { delivered: false, reason: 'Not an email address.' };

  const driver = mailDriver(env);

  if (driver === 'none') {
    // Deliberately says nothing about the message. The body of an undeliverable sign-in
    // mail is the credential this module exists to keep out of the log.
    return { delivered: false, reason: mailMisconfiguration(env) ?? 'No mail provider.' };
  }

  if (driver === 'console') {
    console.log(
      `\n[mail → ${to}] ${mail.subject}\n${mail.text}\n`
      + '(development only: no provider configured, so this was printed rather than sent)\n',
    );
    return { delivered: true, via: 'console' };
  }

  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY?.trim() ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM?.trim(),
        to: [to],
        subject: mail.subject,
        text: mail.text,
        ...(env.MAIL_REPLY_TO?.trim() ? { reply_to: env.MAIL_REPLY_TO.trim() } : {}),
      }),
    });

    if (!response.ok) {
      // The status and nothing else. A provider error body can quote the message it
      // refused, and that message may be a sign-in link.
      return { delivered: false, reason: `The mail provider refused it (${response.status}).` };
    }
    return { delivered: true, via: 'resend' };
  } catch {
    return { delivered: false, reason: 'The mail provider could not be reached.' };
  }
}
