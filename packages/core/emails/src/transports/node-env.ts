/**
 * Transport for Node code, picked from environment variables: the SMTP relay
 * when `SMTP_URL` is set, as the Rust server does on the Kubernetes editions,
 * else whatever `transportFromEnv` picks (Cloudflare REST, Resend).
 *
 * Node only, because of `./smtp`. Workers use `./binding`; code that is also
 * bundled for Workers uses `./env`.
 */

import { withFromAddress, type EmailTransport } from '../transport';
import { transportFromEnv, type EnvTransportVars } from './env';
import { smtpTransport } from './smtp';

export interface NodeEnvTransportVars extends EnvTransportVars {
  /** The relay system email goes through; see `./smtp` for the forms it takes. */
  SMTP_URL?: string;
}

/**
 * SMTP when `SMTP_URL` is set, else `transportFromEnv(env)`; undefined when
 * neither is configured (caller skips sending). Throws on a malformed
 * `SMTP_URL`, so a typo fails loudly instead of silently skipping mail.
 */
export function transportFromNodeEnv(env: NodeEnvTransportVars): EmailTransport | undefined {
  const url = env.SMTP_URL?.trim();
  if (!url) return transportFromEnv(env);
  return withFromAddress(smtpTransport({ url }), env.SYSTEM_EMAIL_FROM);
}
