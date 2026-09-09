/** The WeldPass audit trail for one project. */

import { Badge } from '@weldsuite/ui/components/badge';
import { Card } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import { useParams } from '@/lib/router';
import { useWeldPassAudit } from '@/hooks/queries/use-weldpass-queries';
import {
  EmptyState,
  ErrorBanner,
  InlineSpinner,
  TimeAgo,
  errorMessage,
} from '../../components/shared';

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

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-6">
      <header>
        <h1 className="text-lg font-semibold">{t('weldpass.auditLog')}</h1>
        <p className="text-sm text-muted-foreground">{t('weldpass.audit.subtitle')}</p>
      </header>

      <ErrorBanner error={error ? errorMessage(error, t('weldpass.audit.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !events || events.length === 0 ? (
        <EmptyState title={t('weldpass.audit.emptyTitle')} />
      ) : (
        <Card>
          {events.map((event) => (
            <div
              key={event.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs last:border-0"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant={TONES[event.action] ?? 'secondary'}>{event.action}</Badge>
                {event.targetKey && <span className="font-mono">{event.targetKey}</span>}
              </div>
              <div className="flex items-center gap-3 text-muted-foreground">
                <span className="font-mono opacity-70">{event.actorId.slice(-10)}</span>
                {event.ip && <span className="opacity-70">{event.ip}</span>}
                <TimeAgo value={event.createdAt} />
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
