import '@tanstack/react-start/server-only';

import type { EmailTransport } from '@weldsuite/emails';
import { transportFromEnv } from '@weldsuite/emails/transports/env';

/**
 * How the console sends system email: Cloudflare's REST API (or Resend) on
 * Global. The Node build for Kubernetes resolves this module to
 * `email-transport.node.ts` (an SMTP relay) instead (vite.config.ts).
 * Undefined when nothing is configured; callers then skip the email.
 */
export function systemEmailTransport(): EmailTransport | undefined {
  return transportFromEnv(process.env);
}
