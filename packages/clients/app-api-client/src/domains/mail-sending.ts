/**
 * App-API mail-sending domain client — flat `/api/mail-sending/*`.
 *
 * The customer view of the outbound mail guard: what the workspace may send,
 * what it has used and how its recent mail was delivered. See
 * docs/plans/weldmail-outbound-abuse.md.
 */

import type { ClientApi, DataResponse } from '../types';
import type { OutboundUsage } from '../schemas/outbound-mail';

export function createMailSendingApi(api: ClientApi) {
  return {
    /**
     * Limits, usage and delivery health of the workspace. `data` is null when
     * the guard is not available (mode `off`, or no ledger bound).
     */
    usage(): Promise<DataResponse<OutboundUsage | null>> {
      return api.get<DataResponse<OutboundUsage | null>>('/mail-sending/usage');
    },
  };
}
