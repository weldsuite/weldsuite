/** The WeldPass audit trail for one project. */

import { useMemo, useState } from 'react';
import { ScrollText, SearchX } from 'lucide-react';
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
  const [query, setQuery] = useState('');

  // The toolbar sits above the tabs, outside the list, so the search is
  // applied here rather than by the list.
  const visibleEvents = useMemo(() => {
    const all = events ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((event) =>
      [event.action, event.targetKey].some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [events, query]);
  const isSearchMiss = visibleEvents.length === 0 && (events?.length ?? 0) > 0;

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
    <ProjectPage
      projectId={projectId}
      section="audit"
      toolbar={{
        search: query,
        onSearchChange: setQuery,
        searchPlaceholder: t('weldpass.audit.searchPlaceholder'),
      }}
    >
      <PanelEntityList<WeldPassAuditEvent>
        items={visibleEvents}
        isLoading={isLoading}
        error={error}
        columns={columns}
        hideTopBar
        emptyState={
          isSearchMiss
            ? {
                icon: emptyIcon(SearchX),
                title: t('weldpass.audit.noResultsTitle'),
                description: t('weldpass.audit.noResultsDescription'),
              }
            : {
                icon: emptyIcon(ScrollText),
                title: t('weldpass.audit.emptyTitle'),
                description: t('weldpass.audit.subtitle'),
              }
        }
      />
    </ProjectPage>
  );
}
