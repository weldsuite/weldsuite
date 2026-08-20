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
    ote: env.REALTIME_REGISTER_OTE?.trim().toLowerCase() === 'true',
    adacApiKey: env.REALTIME_REGISTER_ADAC_API_KEY?.trim(),
    adacTldSetToken: env.REALTIME_REGISTER_ADAC_TLD_SET_TOKEN?.trim(),
  });
}
