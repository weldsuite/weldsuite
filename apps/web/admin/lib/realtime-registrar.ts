import 'server-only';

import { RealtimeRegistrar } from '@weldsuite/realtime-registrar';

/**
 * Registrar REST client for admin backfill. Uses the same env names as
 * app-api (`REALTIME_REGISTER_API_KEY` + `REALTIME_REGISTER_CUSTOMER`).
 * This is not the ADAC search key.
 */
export function getAdminRealtimeRegistrar(): RealtimeRegistrar | null {
  const apiKey = process.env.REALTIME_REGISTER_API_KEY?.trim();
  const customer = process.env.REALTIME_REGISTER_CUSTOMER?.trim();
  if (!apiKey || !customer) return null;
  return new RealtimeRegistrar({
    apiKey,
    customer,
    ote: process.env.REALTIME_REGISTER_OTE?.trim().toLowerCase() === 'true',
  });
}
