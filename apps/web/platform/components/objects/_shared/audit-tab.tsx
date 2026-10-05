/**
 * `AuditTab` — Audit Log tab for the company / person object panels.
 *
 * Thin wrapper over the existing `EntityAuditPanel`, which already does
 * the right thing: fetches via `useEntityAuditLogs(entityType, entityId)`
 * and renders a timeline. crm-api's companies/people routes publish entity
 * events with entityType 'company' / 'person' (the Companies/People model),
 * not the legacy 'customer' / 'contact' types — map directly so the audit
 * log endpoint (`/api/audit-logs/company|person/<id>`) actually finds rows.
 */

import { EntityAuditPanel } from '@/components/entity-audit-panel';

interface AuditTabProps {
  entityId: string;
  entityKind: 'company' | 'person';
}

export function AuditTab({ entityId, entityKind }: AuditTabProps) {
  return <EntityAuditPanel entityType={entityKind} entityId={entityId} />;
}
