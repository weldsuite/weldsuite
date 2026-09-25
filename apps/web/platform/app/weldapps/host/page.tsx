import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { Puzzle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { cn } from '@weldsuite/ui/lib/utils';
import { PageLoader } from '@/components/page-loader';
import { Link, useParams, usePathname } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { userAppRelativePath } from '@/components/layout/user-app-sidebar';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';
import { BreadcrumbProvider, useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { attachFrameSlot, detachFrameSlot, useWeldAppFrameStatus } from './frame-store';
import { useWeldAppSource } from './use-weld-app-source';

function sectionLabel(appPath: string): string | null {
  const segment = appPath.replace(/^\/+|\/+$/g, '').split('/')[0];
  if (!segment) return null;
  return segment
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * `/apps/{code}` host page for a WeldApp.
 *
 * Shell chrome matches first-party modules: AppHeader (top nav) + ModuleContent.
 * Section nav lives in UnifiedModuleSidebar from the app's weldapp.json
 * `navigation`.
 *
 * The iframe itself is not rendered here: this page reserves a slot and the
 * shell-level `WeldAppFrameLayer` positions a kept-alive frame over it (see
 * `frame-store.ts`). The bridge (`bridge-host.tsx`) proxies the app's API
 * calls with the member's own session, so no token ever enters the sandbox.
 */
export default function WeldAppHostPage() {
  const { appCode } = useParams<{ appCode: string }>();
  const pathname = usePathname();
  const { t } = useI18n();
  const wa = t.weldapps;
  const source = useWeldAppSource(appCode);
  const { app, isLoading, previewUrl } = source;
  const status = useWeldAppFrameStatus(appCode);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  const appPath = useMemo(() => (appCode ? userAppRelativePath(pathname, appCode) : '/'), [pathname, appCode]);

  useLayoutEffect(() => {
    if (!slot || !app || !appCode) return;
    attachFrameSlot({ appCode, element: slot, path: appPath });
  }, [slot, app, appCode, appPath]);

  useLayoutEffect(() => {
    if (!slot) return;
    return () => detachFrameSlot(slot);
  }, [slot]);

  const breadcrumbs = useMemo(() => {
    const rootHref = appCode ? `/apps/${appCode}` : '/apps';
    const rootLabel = app?.name ?? appCode ?? wa.breadcrumb.title;
    const crumbs: { label: string; href?: string }[] = [{ label: rootLabel, href: rootHref }];
    if (status.breadcrumbs) {
      crumbs.push(...status.breadcrumbs);
    } else {
      const section = sectionLabel(appPath);
      if (section) crumbs.push({ label: section, href: pathname });
    }
    return crumbs;
  }, [app?.name, appCode, appPath, pathname, status.breadcrumbs, wa.breadcrumb.title]);

  // Unsaved changes reported by the app block leaving it (moving between the
  // app's own sections stays allowed — the app guards those itself).
  const dirtyRef = useRef(status.dirty);
  dirtyRef.current = status.dirty;
  const { proceed, reset, status: blockerStatus } = useBlocker({
    shouldBlockFn: ({ next }) => {
      if (!dirtyRef.current) return false;
      const base = `/apps/${appCode}`;
      return next.pathname !== base && !next.pathname.startsWith(`${base}/`);
    },
    withResolver: true,
    enableBeforeUnload: () => !!dirtyRef.current,
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
        <AppHeader />
        <ModuleContent>
          <PageLoader fullScreen={false} label={wa.host.loading} />
        </ModuleContent>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
        <AppHeader />
        <ModuleContent>
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="flex flex-col items-center text-center max-w-md gap-4">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                <Puzzle className="h-6 w-6 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">{wa.host.notInstalledTitle}</h2>
                <p className="text-sm text-muted-foreground leading-relaxed">{wa.host.notInstalledDescription}</p>
              </div>
              <Button asChild>
                <Link href="/appstore">{wa.host.browseAppStore}</Link>
              </Button>
            </div>
          </div>
        </ModuleContent>
      </div>
    );
  }

  return (
    <BreadcrumbProvider defaultBreadcrumbs={breadcrumbs}>
      <HostBreadcrumbSync breadcrumbs={breadcrumbs} />
      <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
        <AppHeader />
        <ModuleContent>
          {previewUrl ? (
            <div
              className="shrink-0 px-4 py-2 text-xs bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100 border-b border-amber-200 dark:border-amber-900 flex items-center gap-2"
              role="status"
            >
              <span className="font-semibold uppercase tracking-wide">{wa.host.developmentBadge}</span>
              <span className="truncate">{wa.host.developmentDescription}</span>
              <span className="ml-auto font-mono truncate opacity-80">{previewUrl}</span>
            </div>
          ) : null}
          {/* Slot the shell's WeldAppFrameLayer covers with the live iframe;
              its border-radius is copied onto the frame. */}
          <div
            ref={setSlot}
            data-weldapp-slot={appCode}
            className={cn('flex-1 min-h-0 bg-background rounded-b-xl', previewUrl ? 'rounded-t-none' : 'rounded-t-xl')}
          />
        </ModuleContent>
      </div>
      <ConfirmDialog
        open={blockerStatus === 'blocked'}
        onOpenChange={(open) => {
          if (!open) reset?.();
        }}
        title={wa.host.leaveTitle}
        description={status.dirty?.message || wa.host.leaveDescription}
        confirmLabel={wa.host.leave}
        cancelLabel={wa.host.stay}
        variant="destructive"
        onConfirm={() => proceed?.()}
      />
    </BreadcrumbProvider>
  );
}

function HostBreadcrumbSync({
  breadcrumbs,
}: {
  breadcrumbs: { label: string; href?: string }[];
}) {
  useBreadcrumbs(breadcrumbs);
  return null;
}
