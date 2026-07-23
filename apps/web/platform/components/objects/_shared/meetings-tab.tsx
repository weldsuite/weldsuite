/**
 * `MeetingsTab` — Meetings tab for the company / person object panels.
 *
 * Renders the EXACT same meeting-history list as the full WeldMeet history
 * page (`/weldmeet/history`) by reusing the shared `MeetingHistoryList`
 * component, so the two surfaces never drift in design. The only difference
 * here is the data scope: meetings are filtered to the current entity via the
 * `counterpartyId` (company) / `personId` (person) query params.
 */

import { useMemo } from 'react';
import { MeetingHistoryList } from '@/app/weldmeet/history/meeting-history-list';
import type { ListMeetingsParams } from '@/lib/api/domains/weldmeet';

interface MeetingsTabProps {
  entityId: string;
  entityKind: 'company' | 'person';
}

export function MeetingsTab({ entityId, entityKind }: MeetingsTabProps) {
  const filter = useMemo<ListMeetingsParams>(
    () =>
      entityKind === 'company'
        ? { counterpartyId: entityId, pageSize: 100 }
        : { personId: entityId, pageSize: 100 },
    [entityId, entityKind],
  );

  return <MeetingHistoryList filter={filter} />;
}
