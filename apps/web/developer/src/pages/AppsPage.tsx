import { Lock, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { useDeveloperI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useCanDevelopApps } from '@/hooks/use-permissions';
import { useMyUserApps, type UserApp } from '@/hooks/use-user-apps';

function visibilityLabel(app: UserApp, t: ReturnType<typeof useDeveloperI18n>['t']): string {
  return app.visibility === 'public' ? t.apps.visibilityPublic : t.apps.visibilityPrivate;
}

function reviewStatusLabel(app: UserApp, t: ReturnType<typeof useDeveloperI18n>['t']): string {
  switch (app.reviewStatus) {
    case 'draft':
      return t.apps.statusDraft;
    case 'submitted':
      return t.apps.statusSubmitted;
    case 'approved':
      return t.apps.statusApproved;
    case 'rejected':
      return t.apps.statusRejected;
    default:
      return app.reviewStatus;
  }
}

function Badge({
  children,
  tone = 'default',
}: Readonly<{
  children: React.ReactNode;
  tone?: 'default' | 'danger';
}>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
        tone === 'danger'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border bg-secondary text-secondary-foreground',
      )}
    >
      {children}
    </span>
  );
}

export function AppsPage() {
  const { t } = useDeveloperI18n();
  const { orgId } = useAuth();
  const { canDevelop, isLoading: permissionsLoading } = useCanDevelopApps();
  const { data: apps, isLoading, isError } = useMyUserApps(!!orgId && canDevelop);

  if (permissionsLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t.shell.loading}
      </div>
    );
  }

  if (!canDevelop) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Lock className="h-6 w-6 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold">{t.apps.noAccessTitle}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{t.apps.noAccessDescription}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t.apps.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t.apps.subtitle}</p>
        </div>
        <Link
          to="/apps/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t.apps.createApp}
        </Link>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t.shell.loading}</p>
        ) : isError ? (
          <p className="text-sm text-destructive">{t.apps.loadError}</p>
        ) : !apps || apps.length === 0 ? (
          <div className="mx-auto max-w-md rounded-lg border border-dashed border-border p-10 text-center">
            <p className="text-sm font-medium">{t.apps.empty}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t.apps.emptyDescription}</p>
            <Link
              to="/apps/new"
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            >
              <Plus className="h-4 w-4" />
              {t.apps.createApp}
            </Link>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">{t.apps.columnName}</th>
                  <th className="px-4 py-3 font-medium">{t.apps.columnCode}</th>
                  <th className="px-4 py-3 font-medium">{t.apps.columnVisibility}</th>
                  <th className="px-4 py-3 font-medium">{t.apps.columnStatus}</th>
                  <th className="px-4 py-3 font-medium">{t.apps.columnInstalls}</th>
                  <th className="px-4 py-3 font-medium">{t.apps.columnVersion}</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => (
                  <tr key={app.id} className="border-t border-border hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">
                      <Link to={`/apps/${app.id}`} className="hover:underline">
                        {app.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{app.code}</td>
                    <td className="px-4 py-3">
                      <Badge>{visibilityLabel(app, t)}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={app.reviewStatus === 'rejected' ? 'danger' : 'default'}>
                        {reviewStatusLabel(app, t)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{app.installCount}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {app.currentVersionId ?? t.apps.noVersion}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
