/**
 * `CallsTab` — Calls tab for the company / person object panels.
 *
 * Renders the EXACT same call-history list as the full WeldCall history page
 * (`/weldcall/history`) by reusing the shared `CallHistoryList` component, so
 * the two surfaces never drift in design. The only difference here is the
 * data scope: calls are filtered to the current entity via the VOIP
 * `customerId` / `contactId` query params.
 */

import { useMemo } from 'react';
import { CallHistoryList } from '@/app/weldcall/call-history-list';
import {
  useVoipCalls,
  useVoipConfigured,
} from '@/hooks/queries/use-voip-calls-queries';

interface CallsTabProps {
  entityId: string;
  entityKind: 'company' | 'person';
  /** Used as the default number when the user clicks "Make call". */
  defaultDialNumber?: string;
}

export function CallsTab({ entityId, entityKind }: CallsTabProps) {
  const filter = useMemo(
    () =>
      entityKind === 'company'
        ? { customerId: entityId, pageSize: 100 }
        : { contactId: entityId, pageSize: 100 },
    [entityId, entityKind],
  );

  const { data, isLoading } = useVoipCalls(filter);
  const { data: voipConfiguredData } = useVoipConfigured();

  return (
    <CallHistoryList
      calls={data?.data ?? []}
      voipConfigured={voipConfiguredData?.configured ?? false}
      isLoading={isLoading}
      showPhoneSettings={false}
    />
  );
}
