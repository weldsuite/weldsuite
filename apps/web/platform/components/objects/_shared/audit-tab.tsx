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

import { useTranslations } from '@weldsuite/i18n/client';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { useEntityAuditLogs } from '@/hooks/queries/use-audit-log-queries';
import { AuditIllustration, TabEmptyState } from './tab-empty-state';

interface AuditTabProps {
  entityId: string;
  entityKind: 'company' | 'person';
}

export function AuditTab({ entityId, entityKind }: Readonly<AuditTabProps>) {
  const t = useTranslations();
  // Same query (and cache entry) `EntityAuditPanel` reads — only here to tell
  // an empty log apart, so it gets the tabs' shared empty state.
  const { data, isLoading } = useEntityAuditLogs(entityKind, entityId);

  if (!isLoading && (data?.data ?? []).length === 0) {
    return (
      <TabEmptyState
        illustration={<AuditIllustration />}
        bare
        title={t('sweep.entities.noAuditYetTitle')}
        description={
          entityKind === 'person'
            ? t('sweep.entities.noAuditYetDescriptionPerson')
            : t('sweep.entities.noAuditYetDescriptionCompany')
        }
      />
    );
  }

  return <EntityAuditPanel entityType={entityKind} entityId={entityId} />;
}
