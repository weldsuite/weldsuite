/**
 * Shared Realtime Register client factory for app-api routes.
 */

import { RealtimeRegistrar } from '@weldsuite/realtime-registrar';
import type { Env } from '../types';

export function getRealtimeRegistrar(env: Env): RealtimeRegistrar | null {
  const apiKey = env.REALTIME_REGISTER_API_KEY?.trim();
  const customer = env.REALTIME_REGISTER_CUSTOMER?.trim();
  if (!apiKey || !customer) return null;
  return new RealtimeRegistrar({
    apiKey,
    customer,
    // Dashboard secrets often pick up a trailing newline; "true\n" must still
    // enable OTE, and anything else (including "false") is production.
    ote: env.REALTIME_REGISTER_OTE?.trim().toLowerCase() === 'true',
  });
}
