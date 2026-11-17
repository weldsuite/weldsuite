/**
 * A group's profile: its properties, the people whose events carried it,
 * recent activity, a link to the matching WeldCRM company (when the group type
 * has a CRM match property and one matches) and deleting the profile.
 */

import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Building2, ExternalLink, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState, EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { DetailHeader, DetailPage, TabBody } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useDeleteWeldPanelGroup, useWeldPanelGroup, useWeldPanelGroupTypes } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter, useSearchParams } from '@/lib/router';
import { isNotFoundError } from '../../lib/api-errors';
import { formatDateTime, formatNumber } from '../../lib/format';
import { propertyText } from '../../lib/people';
import { useCurrentProject } from '../../lib/use-current-project';
import { useProjectParam } from '../../lib/use-project-param';

type ProfileData = NonNullable<ReturnType<typeof useWeldPanelGroup>['data']>;

function PropertiesTab({ data }: Readonly<{ data: ProfileData }>) {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.groups.profile;
  const entries = Object.entries(data.group.properties).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return <EmptyText>{tx.noProperties}</EmptyText>;
  return (
    <TabBody className="p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tx.property}</TableHead>
            <TableHead>{tx.value}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([key, value]) => (
            <TableRow key={key}>
              <TableCell className="font-mono text-xs">{key}</TableCell>
              <TableCell className="max-w-96 break-words">{propertyText(value)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TabBody>
  );
}

function MembersTab({ data, projectId }: Readonly<{ data: ProfileData; projectId: string }>) {
  const { t, language } = useI18n();
  const tx = t.weldpanel.explore.groups.profile;
  const canReadPeople = useCan('panel_people:read');
  if (data.members.length === 0) return <EmptyText>{tx.noMembers}</EmptyText>;
  return (
    <TabBody className="p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tx.memberColumns.person}</TableHead>
            <TableHead>{tx.memberColumns.lastSeen}</TableHead>
            <TableHead className="text-right">{tx.memberColumns.events}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.members.map((member) => (
            <TableRow key={member.distinctId}>
              <TableCell className="max-w-64 truncate font-medium">
                {canReadPeople ? (
                  <Link href={`/weldpanel/users/${encodeURIComponent(member.distinctId)}?project=${encodeURIComponent(projectId)}`} className="hover:underline">
                    {member.distinctId}
                  </Link>
                ) : (
                  member.distinctId
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(member.lastSeen, language)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(member.eventCount, language)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TabBody>
  );
}

function ActivityTab({ data }: Readonly<{ data: ProfileData }>) {
  const { t, language } = useI18n();
  const tx = t.weldpanel.explore.groups.profile;
  if (data.recentEvents.length === 0) return <EmptyText>{tx.noActivity}</EmptyText>;
  return (
    <TabBody className="p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tx.activityColumns.event}</TableHead>
            <TableHead>{tx.activityColumns.page}</TableHead>
            <TableHead>{tx.activityColumns.time}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.recentEvents.map((event) => (
            <TableRow key={event.eventId}>
              <TableCell className="max-w-56 truncate font-medium">{event.name}</TableCell>
              <TableCell className="max-w-72 truncate text-muted-foreground" title={event.url ?? undefined}>
                {event.path ?? '–'}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(event.ts, language)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TabBody>
  );
}

function Profile({ projectId, groupType, groupKey }: Readonly<{ projectId: string; groupType: string; groupKey: string }>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.groups;
  const tp = tx.profile;
  const router = useRouter();
  const canDelete = useCan('panel_people:delete');
  const { data, isLoading, error, refetch } = useWeldPanelGroup(projectId, groupType, groupKey);
  const { data: types } = useWeldPanelGroupTypes(projectId);
  const remove = useDeleteWeldPanelGroup(projectId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const back = `/weldpanel/groups?type=${encodeURIComponent(groupType)}`;

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (error && isNotFoundError(error)) return <EmptyState icon={Building2} title={tp.notFound} />;
  if (error || !data) return <ErrorState message={tp.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  const name = data.group.name?.trim() || data.group.groupKey;
  const typeName = types?.find((g) => g.groupType === groupType)?.nameSingular ?? groupType;

  async function confirmDelete() {
    try {
      await remove.mutateAsync({ groupType, groupKey });
      toast.success(tp.deleted);
      setConfirmOpen(false);
      router.push(back);
    } catch {
      toast.error(tp.deleteFailed);
    }
  }

  return (
    <DetailPage className="mx-auto w-full max-w-6xl">
      <div className="space-y-4 p-4 sm:p-6">
        <DetailHeader
          onBack={() => router.push(back)}
          backLabel={tp.back}
          title={name}
          subtitle={name === data.group.groupKey ? typeName : `${typeName} · ${data.group.groupKey}`}
          actions={
            <>
              {data.crmCompany && (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/weldcrm/companies?stack=company:${encodeURIComponent(data.crmCompany.id)}:panel`}>
                    <ExternalLink />
                    {tp.openInCrm}
                  </Link>
                </Button>
              )}
              {canDelete && data.hasProfile && (
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmOpen(true)}>
                  <Trash2 />
                  {tp.delete}
                </Button>
              )}
            </>
          }
        />

        {!data.hasProfile && <InfoBanner variant="info">{tp.noProfile}</InfoBanner>}

        <KpiGrid className="sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label={tp.firstSeen} value={formatDateTime(data.group.firstSeen, language)} />
          <KpiCard label={tp.lastSeen} value={formatDateTime(data.group.lastSeen, language)} />
          <KpiCard label={format(tp.events, { days: data.days })} value={formatNumber(data.eventCount, language)} />
          <KpiCard label={format(tp.members, { days: data.days })} value={formatNumber(data.memberCount, language)} />
        </KpiGrid>

        <Tabs defaultValue="properties" className="gap-4">
          <TabsList>
            <TabsTrigger value="properties">{tp.tabs.properties}</TabsTrigger>
            <TabsTrigger value="members">{tp.tabs.members}</TabsTrigger>
            <TabsTrigger value="activity">{tp.tabs.activity}</TabsTrigger>
          </TabsList>
          <TabsContent value="properties">
            <PropertiesTab data={data} />
          </TabsContent>
          <TabsContent value="members">
            <MembersTab data={data} projectId={projectId} />
          </TabsContent>
          <TabsContent value="activity">
            <ActivityTab data={data} />
          </TabsContent>
        </Tabs>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={format(tp.deleteTitle, { name })}
        description={tp.deleteDescription}
        confirmLabel={tp.delete}
        cancelLabel={t.weldpanel.analytics.common.cancel}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </DetailPage>
  );
}

export default function GroupProfilePage() {
  const { groupType = '', groupKey = '' } = useParams({ strict: false });
  const search = useSearchParams();
  useProjectParam(search.get('project') ?? undefined);
  const { project, isLoading, isError, refetch } = useCurrentProject();
  const { t } = useI18n();
  const canRead = useCan('panel_people:read');
  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (isError) return <ErrorState message={t.weldpanel.analytics.projectBar.loadFailed} onRetry={refetch} retryLabel={t.weldpanel.retry} />;
  if (!project) return <EmptyState title={t.weldpanel.analytics.needProject.title} description={t.weldpanel.analytics.needProject.description} />;
  if (!canRead) return <EmptyState icon={Building2} title={t.weldpanel.explore.groups.title} description={t.weldpanel.observe.common.noPermission} />;
  return (
    <Profile key={`${project.id}:${groupType}:${groupKey}`} projectId={project.id} groupType={decodeURIComponent(groupType)} groupKey={decodeURIComponent(groupKey)} />
  );
}
