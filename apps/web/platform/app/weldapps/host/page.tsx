
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useUser } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { Puzzle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { PageLoader } from '@/components/page-loader';
import { Link, useParams, usePathname, useRouter } from '@/lib/router';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/lib/i18n/provider';
import {
  useInstalledUserApps,
  useUserAppDevSession,
  useUserAppSessionToken,
} from '@/hooks/queries/use-user-apps-queries';
import { getAppApiUrl } from '@/lib/api/public-env';
import { userAppRelativePath } from '@/components/layout/user-app-sidebar';
import { iframeSandbox, iframeTargetOrigin } from './preview';

const APP_API_BASE = getAppApiUrl();

interface WeldAppReadyMessage {
  type: 'weldapp:ready';
}

interface WeldAppRequestMessage {
  type: 'weldapp:request';
  id: string;
  method: 'getToken' | 'navigate' | 'toast';
  payload?: Record<string, unknown>;
}

type IncomingWeldAppMessage = WeldAppReadyMessage | WeldAppRequestMessage;

/**
 * Full-page sandboxed iframe host for a WeldApp (a workspace-created app).
 *
 * Implements the fixed postMessage bridge described in the WeldApps spec:
 *  - iframe -> host `weldapp:ready` triggers a minted session token and a
 *    `weldapp:init` reply with theme/locale/user/path context.
 *  - iframe -> host `weldapp:request` (getToken | navigate | toast) gets a
 *    matching `weldapp:response`.
 *  - host -> iframe `weldapp:event` pushes live theme/locale/route changes.
 *
 * When the signed-in developer has an active `weld app dev` session, the
 * iframe loads that preview URL instead of the R2 bundle. Everyone else
 * still sees the published bundle.
 *
 * Section navigation lives in the platform UnifiedModuleSidebar (from the
 * app's weldapp.json `navigation`). Subpaths under `/apps/{code}/…` sync to
 * the iframe via init.path + `route` events — apps do not build a sidebar.
 */
export default function WeldAppHostPage() {
  const { appCode } = useParams<{ appCode: string }>();
  const pathname = usePathname();
  const { t, language } = useI18n();
  const wa = t.weldapps;
  const router = useRouter();
  const { user } = useUser();
  const { resolvedTheme } = useTheme();
  const { data: installedApps, isLoading } = useInstalledUserApps();
  const { data: devSession } = useUserAppDevSession(appCode);
  const sessionTokenMutation = useUserAppSessionToken();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const app = installedApps?.find((a) => a.appCode === appCode);
  const bundleSrc = appCode ? `${APP_API_BASE}/public/user-apps/${appCode}/index.html` : '';
  const previewUrl = devSession?.url ?? null;
  const iframeSrc = previewUrl ?? bundleSrc;
  const targetOrigin = useMemo(() => iframeTargetOrigin(iframeSrc), [iframeSrc]);
  const sandbox = useMemo(() => iframeSandbox(iframeSrc), [iframeSrc]);
  const appPath = useMemo(
    () => (appCode ? userAppRelativePath(pathname, appCode) : '/'),
    [pathname, appCode],
  );

  const mintSessionToken = useCallback(async () => {
    if (!appCode) return null;
    try {
      return await sessionTokenMutation.mutateAsync(appCode);
    } catch {
      return null;
    }
  }, [appCode, sessionTokenMutation]);

  // The postMessage bridge itself. Re-bound whenever anything it captures in
  // its closure (theme, locale, user, appCode, path, targetOrigin) changes so replies
  // always reflect the current host state.
  useEffect(() => {
    if (!appCode) return;

    const handleMessage = async (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || event.source !== iframeWindow) return;

      const data = event.data as IncomingWeldAppMessage | undefined;
      if (!data || typeof data !== 'object' || !('type' in data)) return;

      if (data.type === 'weldapp:ready') {
        const session = await mintSessionToken();
        iframeWindow.postMessage(
          {
            type: 'weldapp:init',
            payload: {
              appCode,
              theme: resolvedTheme,
              locale: language,
              path: appPath,
              apiBaseUrl: session?.apiBaseUrl ?? APP_API_BASE,
              token: session?.token ?? null,
              tokenExpiresAt: session?.expiresAt ?? null,
              user: user
                ? { id: user.id, name: user.fullName || user.firstName || '', imageUrl: user.imageUrl }
                : null,
            },
          },
          targetOrigin,
        );
        return;
      }

      if (data.type === 'weldapp:request') {
        const { id, method, payload } = data;
        try {
          let responsePayload: unknown;
          switch (method) {
            case 'getToken': {
              const session = await mintSessionToken();
              if (!session) throw new Error('Failed to mint session token');
              responsePayload = {
                token: session.token,
                tokenExpiresAt: session.expiresAt,
                apiBaseUrl: session.apiBaseUrl,
              };
              break;
            }
            case 'navigate': {
              const to = (payload as { to?: unknown } | undefined)?.to;
              // Only platform-internal paths — never let a sandboxed app
              // redirect the host to an external origin. '//' would be a
              // protocol-relative external URL.
              if (typeof to !== 'string' || !to.startsWith('/') || to.startsWith('//')) {
                throw new Error('Only platform-internal paths are allowed');
              }
              router.push(to);
              responsePayload = { to };
              break;
            }
            case 'toast': {
              const body = (payload ?? {}) as { message?: unknown; variant?: 'success' | 'error' | 'info' };
              if (typeof body.message === 'string') {
                if (body.variant === 'success') toast.success(body.message);
                else if (body.variant === 'error') toast.error(body.message);
                else toast(body.message);
              }
              responsePayload = {};
              break;
            }
            default:
              throw new Error(`Unknown method: ${String(method)}`);
          }
          iframeWindow.postMessage({ type: 'weldapp:response', id, ok: true, payload: responsePayload }, targetOrigin);
        } catch (error) {
          iframeWindow.postMessage(
            {
              type: 'weldapp:response',
              id,
              ok: false,
              error: { message: error instanceof Error ? error.message : 'Request failed' },
            },
            targetOrigin,
          );
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [appCode, appPath, mintSessionToken, resolvedTheme, language, user, router, targetOrigin]);

  // Push live theme/locale/route changes to an already-initialized iframe.
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'weldapp:event', event: 'theme', payload: { value: resolvedTheme } },
      targetOrigin,
    );
  }, [resolvedTheme, targetOrigin]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'weldapp:event', event: 'locale', payload: { value: language } },
      targetOrigin,
    );
  }, [language, targetOrigin]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'weldapp:event', event: 'route', payload: { value: appPath } },
      targetOrigin,
    );
  }, [appPath, targetOrigin]);

  if (isLoading) {
    return (
      <div className="w-full h-full bg-background flex flex-col overflow-hidden">
        <BreadcrumbHeader segments={[{ label: wa.breadcrumb.title }]} />
        <PageLoader fullScreen={false} label={wa.host.loading} />
      </div>
    );
  }

  if (!app) {
    return (
      <div className="w-full h-full bg-background flex flex-col overflow-hidden">
        <BreadcrumbHeader segments={[{ label: wa.breadcrumb.title }]} />
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
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-background flex flex-col overflow-hidden">
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
      <div className="flex-1 min-h-0">
        <iframe
          key={iframeSrc}
          ref={iframeRef}
          src={iframeSrc}
          title={app.name}
          className="w-full h-full border-0"
          sandbox={sandbox}
        />
      </div>
    </div>
  );
}
