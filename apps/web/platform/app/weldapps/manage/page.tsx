
import { useState } from 'react';
import { Lock, Plus } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@weldsuite/ui/components/table';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import type { TranslationNamespaces } from '@/lib/i18n';
import { useMyUserApps, type UserApp } from '@/hooks/queries/use-user-apps-queries';
import { CreateAppDialog } from './create-app-dialog';
import { AppDetailPanel } from './app-detail-panel';

function ManageAppsNoAccess({ title }: { title: string }) {
  const { t } = useI18n();
  const wa = t.weldapps;
  return (
    <div className="w-full h-full bg-background flex flex-col overflow-hidden">
      <BreadcrumbHeader segments={[{ label: title }]} />
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="flex flex-col items-center text-center max-w-md">
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
            <Lock className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-2">{wa.manage.noAccessTitle}</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">{wa.manage.noAccessDescription}</p>
        </div>
      </div>
    </div>
  );
}

type WeldAppsT = TranslationNamespaces['weldapps'];

function visibilityLabel(app: UserApp, wa: WeldAppsT): string {
  return app.visibility === 'public' ? wa.manage.visibilityPublic : wa.manage.visibilityPrivate;
}

function reviewStatusLabel(app: UserApp, wa: WeldAppsT): string {
  switch (app.reviewStatus) {
    case 'draft': return wa.manage.statusDraft;
    case 'submitted': return wa.manage.statusSubmitted;
    case 'approved': return wa.manage.statusApproved;
    case 'rejected': return wa.manage.statusRejected;
    default: return app.reviewStatus;
  }
}

export default function WeldAppsManagePage() {
  const { t } = useI18n();
  const wa = t.weldapps;
  const { can, isOwner, isLoading: permissionsLoading } = usePermissions();
  const canDevelop = isOwner || can('weldapps:develop');

  const { data: apps, isLoading } = useMyUserApps();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);

  if (permissionsLoading) return <PageLoader fullScreen={false} />;
  if (!canDevelop) return <ManageAppsNoAccess title={wa.manage.title} />;

  return (
    <div className="w-full h-full bg-background flex flex-col overflow-hidden">
      <BreadcrumbHeader
        segments={[{ label: wa.breadcrumb.title, href: '/appstore' }, { label: wa.manage.title }]}
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            {wa.manage.createApp}
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <PageLoader fullScreen={false} />
        ) : !apps || apps.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center max-w-md mx-auto">
            <p className="text-sm font-medium text-foreground mb-1">{wa.manage.empty}</p>
            <p className="text-xs text-muted-foreground mb-4">{wa.manage.emptyDescription}</p>
            <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              {wa.manage.createApp}
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{wa.manage.columnName}</TableHead>
                <TableHead>{wa.manage.columnCode}</TableHead>
                <TableHead>{wa.manage.columnVisibility}</TableHead>
                <TableHead>{wa.manage.columnStatus}</TableHead>
                <TableHead>{wa.manage.columnInstalls}</TableHead>
                <TableHead>{wa.manage.columnVersion}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => (
                <TableRow
                  key={app.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedAppId(app.id)}
                >
                  <TableCell className="font-medium">{app.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{app.code}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{visibilityLabel(app, wa)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={app.reviewStatus === 'rejected' ? 'destructive' : 'secondary'}>
                      {reviewStatusLabel(app, wa)}
                    </Badge>
                  </TableCell>
                  <TableCell>{app.installCount}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {app.currentVersionId ? app.currentVersionId : wa.manage.noVersion}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <CreateAppDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(app) => setSelectedAppId(app.id)}
      />

      <AppDetailPanel
        appId={selectedAppId ?? ''}
        open={!!selectedAppId}
        onOpenChange={(open) => !open && setSelectedAppId(null)}
        onDeleted={() => setSelectedAppId(null)}
      />
    </div>
  );
}
