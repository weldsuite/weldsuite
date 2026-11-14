/**
 * A profile: properties, an activity timeline, the person's recordings, a link
 * to the matching WeldCRM person (found by email) and GDPR erasure behind a
 * typed confirmation.
 */

import { useMemo, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { ExternalLink, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState, EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { DetailHeader, DetailPage, TabBody } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { usePersonSearch } from '@/components/objects/person/use-person-data';
import { useAppAccess } from '@/hooks/use-app-access';
import { useEraseWeldPanelPerson, useWeldPanelPerson } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter, useSearchParams } from '@/lib/router';
import { TypedConfirmDialog } from '../../components/typed-confirm-dialog';
import { SignalBadges } from '../../recordings/signal-badges';
import { isNotFoundError } from '../../lib/api-errors';
import { formatDateTime, formatDuration, formatNumber } from '../../lib/format';
import { personRecordingsHref } from '../../lib/observe-links';
import { personDisplayName, propertyText } from '../../lib/people';
import { useCurrentProject } from '../../lib/use-current-project';
import { useProjectParam } from '../../lib/use-project-param';

export default function UserProfilePage() {
  const { distinctId = '' } = useParams({ strict: false });
  const search = useSearchParams();
  useProjectParam(search.get('project') ?? undefined);
  const { project, isLoading, isError, refetch } = useCurrentProject();
  const { t } = useI18n();
  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (isError) return <ErrorState message={t.weldpanel.analytics.projectBar.loadFailed} onRetry={refetch} retryLabel={t.weldpanel.retry} />;
  if (!project) return <EmptyState title={t.weldpanel.analytics.needProject.title} description={t.weldpanel.analytics.needProject.description} />;
  return <Profile key={`${project.id}:${distinctId}`} projectId={project.id} distinctId={decodeURIComponent(distinctId)} />;
}

/** The WeldCRM person with this email, if WeldCRM is installed and one exists. */
function useCrmPerson(email: string | null) {
  const { isInstalled } = useAppAccess('weldcrm');
  const address = email?.trim().toLowerCase() ?? '';
  const { data } = usePersonSearch(address, isInstalled && address !== '');
  return useMemo(() => (isInstalled ? (data?.data.find((p) => p.email?.toLowerCase() === address) ?? null) : null), [data, address, isInstalled]);
}

function Profile({ projectId, distinctId }: Readonly<{ projectId: string; distinctId: string }>) {
  const { t, language, format } = useI18n();
  const tp = t.weldpanel.observe.person;
  const router = useRouter();
  const canErase = useCan('panel_people:delete');
  const canWatch = useCan('panel_recordings:read');
  const { data, isLoading, error, refetch } = useWeldPanelPerson(projectId, distinctId);
  const erase = useEraseWeldPanelPerson(projectId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const crmPerson = useCrmPerson(data?.person.email ?? null);
  const name = data ? personDisplayName(data.person) : distinctId;

  useBreadcrumbs(
    [
      { label: t.weldpanel.breadcrumb.home, href: '/weldpanel' },
      { label: t.navigation.moduleSidebar.weldpanel.users, href: '/weldpanel/users' },
      { label: name },
    ],
    { enabled: !!data },
  );

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;

  if (error || !data) {
    const missing = isNotFoundError(error);
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState message={missing ? tp.notFound : tp.loadFailed} onRetry={missing ? undefined : () => void refetch()} retryLabel={t.weldpanel.retry} />
        <Button variant="outline" size="sm" className="mt-3" onClick={() => router.push('/weldpanel/users')}>
          {tp.backToUsers}
        </Button>
      </div>
    );
  }

  const { person } = data;
  const properties = Object.entries(person.properties);

  async function confirmErase() {
    try {
      const result = await erase.mutateAsync(distinctId);
      toast.success(format(tp.erase.done, { ids: result.erasedIdCount, chunks: result.recordingChunksDeleted }));
      setConfirmOpen(false);
      router.push('/weldpanel/users');
    } catch {
      toast.error(tp.erase.failed);
    }
  }

  return (
    <DetailPage className="mx-auto w-full max-w-6xl">
      <div className="space-y-4 p-4 sm:p-6">
        <DetailHeader
          onBack={() => router.push('/weldpanel/users')}
          backLabel={tp.backToUsers}
          title={name}
          subtitle={person.email && person.email !== name ? person.email : undefined}
          actions={
            <>
              {crmPerson && (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/weldcrm/people/${encodeURIComponent(crmPerson.id)}`}>
                    <ExternalLink />
                    {tp.openInCrm}
                  </Link>
                </Button>
              )}
              {canErase && (
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmOpen(true)}>
                  <Trash2 />
                  {tp.erase.button}
                </Button>
              )}
            </>
          }
        />

        <KpiGrid className="sm:grid-cols-3">
          <KpiCard label={tp.firstSeen} value={formatDateTime(person.firstSeen, language)} />
          <KpiCard label={tp.lastSeen} value={formatDateTime(person.lastSeen, language)} />
          <KpiCard label={tp.events90d} value={formatNumber(data.eventCount90d, language)} />
        </KpiGrid>

        <Tabs defaultValue="overview" className="gap-4">
          <TabsList>
            <TabsTrigger value="overview">{tp.tabs.overview}</TabsTrigger>
            <TabsTrigger value="activity">{tp.tabs.activity}</TabsTrigger>
            <TabsTrigger value="recordings">{tp.tabs.recordings}</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <TabBody className="p-0">
              <SectionCard title={tp.properties}>
                {properties.length === 0 ? (
                  <EmptyText>{tp.noProperties}</EmptyText>
                ) : (
                  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(8rem,14rem)_1fr]">
                    {properties.map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="truncate text-muted-foreground">{key}</dt>
                        <dd className="min-w-0 break-words">{propertyText(value) || '–'}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </SectionCard>
              <SectionCard title={tp.userId}>
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(8rem,14rem)_1fr]">
                  <dt className="text-muted-foreground">{tp.userId}</dt>
                  <dd className="break-all font-mono text-xs">{person.userId}</dd>
                  <dt className="text-muted-foreground">{tp.anonIds}</dt>
                  <dd className="break-all font-mono text-xs">{person.anonIds.length === 0 ? tp.noAnonIds : person.anonIds.join(', ')}</dd>
                </dl>
              </SectionCard>
            </TabBody>
          </TabsContent>

          <TabsContent value="activity">
            <SectionCard title={tp.activity}>
              {data.recentEvents.length === 0 ? (
                <EmptyText>{tp.noActivity}</EmptyText>
              ) : (
                <ol className="grid gap-0 border-l pl-4">
                  {data.recentEvents.map((event) => (
                    <li key={event.eventId} className="relative pb-4 last:pb-0">
                      <span className="absolute -left-[1.3rem] top-1.5 size-2 rounded-full bg-primary" aria-hidden />
                      <p className="text-sm font-medium">{event.name}</p>
                      {(event.path ?? event.detail) && <p className="truncate text-sm text-muted-foreground">{[event.path, event.detail].filter(Boolean).join(' · ')}</p>}
                      <p className="text-xs text-muted-foreground">{formatDateTime(event.ts, language)}</p>
                    </li>
                  ))}
                </ol>
              )}
            </SectionCard>
          </TabsContent>

          <TabsContent value="recordings">
            <SectionCard
              title={tp.recordings}
              action={
                canWatch ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={personRecordingsHref(person.userId, projectId)}>{tp.allRecordings}</Link>
                  </Button>
                ) : undefined
              }
            >
              {data.sessions.length === 0 ? (
                <EmptyText>{tp.noRecordings}</EmptyText>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t.weldpanel.observe.recordings.columns.started}</TableHead>
                        <TableHead>{t.weldpanel.observe.recordings.columns.duration}</TableHead>
                        <TableHead>{t.weldpanel.observe.recordings.columns.pages}</TableHead>
                        <TableHead>{t.weldpanel.observe.recordings.columns.signals}</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.sessions.map((session) => (
                        <TableRow key={session.sessionId}>
                          <TableCell className="whitespace-nowrap">{formatDateTime(session.startedAt, language)}</TableCell>
                          <TableCell className="tabular-nums">{formatDuration(session.durationSeconds)}</TableCell>
                          <TableCell className="tabular-nums">{session.pageviews}</TableCell>
                          <TableCell>
                            <SignalBadges session={session} />
                          </TableCell>
                          <TableCell className="text-right">
                            {canWatch && session.hasRecording && (
                              <Button asChild variant="ghost" size="sm">
                                <Link href={`/weldpanel/recordings/${encodeURIComponent(session.sessionId)}?project=${encodeURIComponent(projectId)}`}>{tp.watch}</Link>
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </SectionCard>
          </TabsContent>
        </Tabs>
      </div>

      <TypedConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={format(tp.erase.title, { name })}
        description={tp.erase.description}
        expected={name}
        prompt={format(tp.erase.prompt, { name })}
        confirmLabel={tp.erase.confirm}
        cancelLabel={tp.erase.cancel}
        onConfirm={confirmErase}
      />
    </DetailPage>
  );
}
