import '@tanstack/react-start/server-only';

import { transportFromNodeEnv } from '@weldsuite/emails/transports/node-env';
import type * as Workers from './email-transport';

/**
 * The Node version of `email-transport.ts`, for the console on Kubernetes (ADR
 * FE-018): the SMTP relay in `SMTP_URL`, the one the Rust server sends its
 * system email through, from `SYSTEM_EMAIL_FROM`.
 */
export const systemEmailTransport: typeof Workers.systemEmailTransport = () => transportFromNodeEnv(process.env);
