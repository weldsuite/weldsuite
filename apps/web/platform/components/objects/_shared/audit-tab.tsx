/**
 * `AuditTab` — Audit Log tab for the company / person object panels.
 *
 * Thin wrapper over the existing `EntityAuditPanel`, which already does
 * the right thing: fetches via `useEntityAuditLogs(entityType, entityId)`
 * and renders a timeline. Customer-detail uses entityType='customer' for
 * the legacy customer entity; we follow the same convention since the
 * audit log writes haven't been renamed.
 */

import { EntityAuditPanel } from '@/components/entity-audit-panel';

interface AuditTabProps {
  entityId: string;
  entityKind: 'company' | 'person';
}

export function AuditTab({ entityId, entityKind }: AuditTabProps) {
  const entityType = entityKind === 'company' ? 'customer' : 'contact';
  return <EntityAuditPanel entityType={entityType} entityId={entityId} />;
}
