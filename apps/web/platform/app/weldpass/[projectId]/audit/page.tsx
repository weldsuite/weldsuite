/** The WeldPass audit trail for one project. */

import { ScrollText } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import type { WeldPassAuditEvent } from '@weldsuite/app-api-client/domains/weldpass';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useParams } from '@/lib/router';
import { useWeldPassAudit } from '@/hooks/queries/use-weldpass-queries';
import { emptyIcon } from '../../components/page-kit';
import { TimeAgo } from '../../components/shared';
import { ProjectPage } from '../components/project-page';

/** Actions worth flagging at a glance. */
const TONES: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  'secret.revealed': 'outline',
  'secret.exported': 'outline',
  'secret.deleted': 'destructive',
  'project.deleted': 'destructive',
  'credential.deleted': 'destructive',
  'sync.failed': 'destructive',
  'sync.pushed': 'default',
};

export default function WeldPassAuditPage() {
  const t = useTranslations();
  const { projectId } = useParams() as { projectId: string };
  const { data: events, isLoading, error } = useWeldPassAudit(projectId);

  const columns: ColumnDef<WeldPassAuditEvent>[] = [
    {
      id: 'action',
      header: t('weldpass.audit.table.action'),
      width: 'w-[200px]',
      render: (event) => <Badge variant={TONES[event.action] ?? 'secondary'}>{event.action}</Badge>,
    },
    {
      id: 'target',
      header: t('weldpass.audit.table.target'),
      width: 'flex-1',
      render: (event) =>
        event.targetKey ? (
          <span className="block truncate font-mono text-xs">{event.targetKey}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'actor',
      header: t('weldpass.audit.table.actor'),
      width: 'w-[140px]',
      render: (event) => (
        <span className="font-mono text-xs text-muted-foreground" title={event.actorId}>
          {event.actorId.slice(-10)}
        </span>
      ),
    },
    {
      id: 'ip',
      header: t('weldpass.audit.table.ip'),
      width: 'w-[140px]',
      render: (event) => (
        <span className="text-xs text-muted-foreground">{event.ip ?? '—'}</span>
      ),
    },
    {
      id: 'when',
      header: t('weldpass.audit.table.when'),
      width: 'w-[140px]',
      render: (event) => (
        <span className="text-xs">
          <TimeAgo value={event.createdAt} />
        </span>
      ),
    },
  ];

  return (
    <ProjectPage projectId={projectId} section="audit">
      <PanelEntityList<WeldPassAuditEvent>
        items={events ?? []}
        isLoading={isLoading}
        error={error}
        columns={columns}
        searchFields={['action', 'targetKey']}
        searchPlaceholder={t('weldpass.audit.searchPlaceholder')}
        emptyState={{
          icon: emptyIcon(ScrollText),
          title: t('weldpass.audit.emptyTitle'),
          description: t('weldpass.audit.subtitle'),
        }}
        noResultsState={{
          title: t('weldpass.audit.noResultsTitle'),
          description: t('weldpass.audit.noResultsDescription'),
        }}
      />
    </ProjectPage>
  );
}
