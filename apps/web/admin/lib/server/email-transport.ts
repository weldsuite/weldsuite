import '@tanstack/react-start/server-only';

import type { EmailTransport } from '@weldsuite/emails';
import { transportFromNodeEnv } from '@weldsuite/emails/transports/node-env';

/**
 * How the console sends system email (ADR FE-018): the SMTP relay in
 * `SMTP_URL`, the one the Rust server sends its system email through, from
 * `SYSTEM_EMAIL_FROM`. Undefined when nothing is configured; callers then skip
 * the email.
 */
export function systemEmailTransport(): EmailTransport | undefined {
  return transportFromNodeEnv(process.env);
}
