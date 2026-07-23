import { useEntityAuditLogs } from '@/hooks/queries/use-audit-log-queries';
import { AuditTimeline, AuditTimelineSkeleton } from './audit-timeline';
import type { AuditLogEntry } from './audit-timeline';

interface EntityAuditPanelProps {
  entityType: string;
  entityId: string;
}

export function EntityAuditPanel({ entityType, entityId }: EntityAuditPanelProps) {
  const { data, isLoading } = useEntityAuditLogs(entityType, entityId);

  if (isLoading) {
    return (
      <div className="px-4 py-6">
        <AuditTimelineSkeleton />
      </div>
    );
  }

  const logs: AuditLogEntry[] = (data?.data ?? []).map((log) => ({
    id: log.id,
    action: log.action,
    description: log.description,
    changes: log.changes,
    performedBy: log.performedBy,
    performedByName: log.performedByName,
    createdAt: log.createdAt,
  }));

  return (
    <div className="px-4 py-6">
      <AuditTimeline logs={logs} />
    </div>
  );
}
