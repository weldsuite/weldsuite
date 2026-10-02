import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { cn } from '@weldsuite/ui/lib/utils';
import { useRouter } from '@/lib/router';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/lib/i18n/provider';
import { useUserAppSessionToken } from '@/hooks/queries/use-user-apps-queries';
import { readPlatformDesignTokens } from './design-tokens';
import {
  HOST_BRIDGE_PROTOCOL,
  parseConfirmRequest,
  parseOpenModalRequest,
  parseProxyFetchRequest,
  parseShortcut,
  resolveProxyUrl,
  toPlatformBreadcrumbs,
  type ConfirmRequest,
  type IncomingWeldAppMessage,
  type ModalSize,
  type OpenModalRequest,
  type ProxyFetchResponse,
  type WeldAppSurface,
} from './protocol';
import { APP_API_BASE, bootstrapFrameSrc } from './use-weld-app-source';

/** Decode JWT `exp` (seconds) → ISO string; fall back to ~55s for Clerk sessions. */
function tokenExpiresAt(token: string): string {
  try {
    const payload = token.split('.')[1];
    if (!payload) throw new Error('missing payload');
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    if (typeof json.exp === 'number' && Number.isFinite(json.exp)) {
      return new Date(json.exp * 1000).toISOString();
    }
  } catch {
    // fall through
  }
  return new Date(Date.now() + 55_000).toISOString();
}

/**
 * Apps on SDKs older than protocol 2 never send `mounted`; reveal them this
 * long after the document loaded instead of keeping the skeleton forever.
 */
export const LEGACY_MOUNT_FALLBACK_MS = 1500;

class BridgeRequestError extends Error {}

export interface BridgeHostOptions {
  appCode: string;
  appName: string;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  targetOrigin: string;
  usesPlatformSession: boolean;
  /** App-relative route; pushed to the app as `route` events. */
  path: string;
  surface: WeldAppSurface;
  modal?: { title?: string; params?: unknown };
  /** Frame-level base src, reused for modal instances. */
  frameSrc: string;
  sandbox: string;
  onMounted: () => void;
  onBreadcrumbs?: (crumbs: { label: string; href?: string }[]) => void;
  onDirty?: (dirty: { message?: string } | null) => void;
  /** Modal surface only: the app called `closeModal(result)`. */
  onCloseModal?: (result: unknown) => void;
}

interface PendingConfirm {
  request: ConfirmRequest;
  resolve: (confirmed: boolean) => void;
}

interface PendingModal {
  request: OpenModalRequest;
  resolve: (outcome: { dismissed: boolean; result?: unknown }) => void;
}

/** What a bridge method hands back to be posted as the `ok` response. */
interface BridgeResult {
  payload: unknown;
  transfer?: Transferable[];
  /** Runs after the response was posted (e.g. closing the modal hosting the frame). */
  afterRespond?: () => void;
}

type BridgeMethodHandler = (payload: unknown, opts: BridgeHostOptions) => BridgeResult | Promise<BridgeResult>;

interface BridgeMethodDeps {
  live: { current: { router: { push: (to: string) => void }; pendingModal: PendingModal | null } };
  proxyFetch: (payload: unknown) => Promise<{ response: ProxyFetchResponse; transfer: Transferable[] }>;
  mintLegacyToken: () => Promise<{ token: string; tokenExpiresAt: string; apiBaseUrl: string } | null>;
  setPendingConfirm: (pending: PendingConfirm) => void;
  setPendingModal: (pending: PendingModal) => void;
}

function showAppToast(payload: unknown): void {
  const body = (payload ?? {}) as { message?: unknown; variant?: string };
  if (typeof body.message !== 'string') return;
  const message = body.message.slice(0, 500);
  switch (body.variant) {
    case 'success':
      toast.success(message);
      break;
    case 'error':
      toast.error(message);
      break;
    case 'warning':
      toast.warning(message);
      break;
    default:
      toast(message);
  }
}

/** One handler per bridge request method; unknown methods are rejected by the caller. */
function createBridgeMethods(deps: BridgeMethodDeps): Map<string, BridgeMethodHandler> {
  const { live, proxyFetch, mintLegacyToken, setPendingConfirm, setPendingModal } = deps;

  const fetchMethod: BridgeMethodHandler = async (payload) => {
    const { response, transfer } = await proxyFetch(payload);
    return { payload: response, transfer };
  };

  const getTokenMethod: BridgeMethodHandler = async () => {
    const session = await mintLegacyToken();
    if (!session) throw new BridgeRequestError('Failed to mint session token');
    return { payload: session };
  };

  const navigateMethod: BridgeMethodHandler = (payload) => {
    const to = (payload as { to?: unknown } | undefined)?.to;
    if (typeof to !== 'string' || !to.startsWith('/') || to.startsWith('//')) {
      throw new BridgeRequestError('Only platform-internal paths are allowed');
    }
    live.current.router.push(to);
    return { payload: { to } };
  };

  const toastMethod: BridgeMethodHandler = (payload) => {
    showAppToast(payload);
    return { payload: {} };
  };

  const setBreadcrumbsMethod: BridgeMethodHandler = (payload, opts) => {
    const items = (payload as { items?: unknown } | undefined)?.items;
    opts.onBreadcrumbs?.(toPlatformBreadcrumbs(opts.appCode, items));
    return { payload: {} };
  };

  const setDirtyMethod: BridgeMethodHandler = (payload, opts) => {
    const body = (payload ?? {}) as { dirty?: unknown; message?: unknown };
    const message = typeof body.message === 'string' ? body.message.slice(0, 300) : undefined;
    opts.onDirty?.(body.dirty === true ? { message } : null);
    return { payload: {} };
  };

  const confirmMethod: BridgeMethodHandler = async (payload) => {
    const request = parseConfirmRequest(payload);
    if (!request) throw new BridgeRequestError('confirm() needs a title');
    const confirmed = await new Promise<boolean>((resolve) => {
      setPendingConfirm({ request, resolve });
    });
    return { payload: { confirmed } };
  };

  const openModalMethod: BridgeMethodHandler = async (payload, opts) => {
    if (opts.surface !== 'page') throw new BridgeRequestError('A modal cannot open another modal');
    if (live.current.pendingModal) throw new BridgeRequestError('A modal is already open');
    const request = parseOpenModalRequest(payload);
    if (!request) throw new BridgeRequestError('openModal() needs an app-relative path');
    const outcome = await new Promise<{ dismissed: boolean; result?: unknown }>((resolve) => {
      setPendingModal({ request, resolve });
    });
    return { payload: outcome };
  };

  const closeModalMethod: BridgeMethodHandler = (payload, opts) => {
    const { onCloseModal } = opts;
    if (opts.surface !== 'modal' || !onCloseModal) {
      throw new BridgeRequestError('closeModal() is only available inside a modal');
    }
    return {
      payload: {},
      afterRespond: () => onCloseModal((payload as { result?: unknown } | undefined)?.result),
    };
  };

  return new Map<string, BridgeMethodHandler>([
    ['fetch', fetchMethod],
    ['getToken', getTokenMethod],
    ['navigate', navigateMethod],
    ['toast', toastMethod],
    ['setBreadcrumbs', setBreadcrumbsMethod],
    ['setDirty', setDirtyMethod],
    ['confirm', confirmMethod],
    ['openModal', openModalMethod],
    ['closeModal', closeModalMethod],
  ]);
}

/**
 * Runs the host side of the bridge for one iframe: handshake, proxied API
 * calls with the member's platform session, theme / locale / route pushes,
 * and host-rendered overlays (confirm dialogs, modals) that escape the
 * iframe rectangle. Returns the overlay elements to render.
 */
export function useBridgeHost(options: BridgeHostOptions): ReactNode {
  const { getToken } = useAuth();
  const { user } = useUser();
  const { resolvedTheme } = useTheme();
  const { t, language } = useI18n();
  const router = useRouter();
  const sessionTokenMutation = useUserAppSessionToken();
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [pendingModal, setPendingModal] = useState<PendingModal | null>(null);

  const theme: 'light' | 'dark' = resolvedTheme === 'dark' ? 'dark' : 'light';

  // Latest values for the long-lived message listener.
  const live = useRef({ options, theme, language, user, getToken, router, sessionTokenMutation, pendingModal });
  live.current = { options, theme, language, user, getToken, router, sessionTokenMutation, pendingModal };

  const { iframeRef, targetOrigin } = options;

  const post = useCallback(
    (message: unknown, transfer?: Transferable[]) => {
      iframeRef.current?.contentWindow?.postMessage(message, { targetOrigin, transfer });
    },
    [iframeRef, targetOrigin],
  );

  /** Legacy (protocol 1 SDK) token path — only runs when an old bundle asks. */
  const mintLegacyToken = useCallback(async () => {
    const { options: opts, getToken: getClerkToken, sessionTokenMutation: mutation } = live.current;
    if (opts.usesPlatformSession) {
      const token = await getClerkToken();
      if (!token) return null;
      return { token, tokenExpiresAt: tokenExpiresAt(token), apiBaseUrl: APP_API_BASE };
    }
    const session = await mutation.mutateAsync(opts.appCode);
    return { token: session.token, tokenExpiresAt: session.expiresAt, apiBaseUrl: session.apiBaseUrl };
  }, []);

  /** Perform an app API call outside the sandbox with the platform session. */
  const proxyFetch = useCallback(async (payload: unknown): Promise<{ response: ProxyFetchResponse; transfer: Transferable[] }> => {
    const { options: opts, getToken: getClerkToken } = live.current;
    const request = parseProxyFetchRequest(payload);
    if (!request) throw new BridgeRequestError('Malformed fetch request');
    const url = resolveProxyUrl({
      apiBase: APP_API_BASE,
      appCode: opts.appCode,
      usesPlatformSession: opts.usesPlatformSession,
      path: request.path,
    });
    if (!url) {
      throw new BridgeRequestError(
        opts.usesPlatformSession
          ? 'Only app-api paths under /api/ are available to this app'
          : 'Only external API paths under /v1/ are available to apps',
      );
    }
    const token = await getClerkToken();
    if (!token) throw new BridgeRequestError('Not signed in');

    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(url, { method: request.method, headers, body: request.body });
    const body = request.method === 'HEAD' ? null : await res.arrayBuffer();
    const responseHeaders: [string, string][] = [];
    res.headers.forEach((value, name) => {
      responseHeaders.push([name, value]);
    });
    return {
      response: { status: res.status, statusText: res.statusText, headers: responseHeaders, body },
      transfer: body ? [body] : [],
    };
  }, []);

  const sendInit = useCallback(() => {
    const { options: opts, theme: currentTheme, language: locale, user: currentUser } = live.current;
    post({
      type: 'weldapp:init',
      payload: {
        appCode: opts.appCode,
        theme: currentTheme,
        locale,
        path: opts.path,
        apiBaseUrl: APP_API_BASE,
        // Protocol 2: no credential enters the sandbox; requests are proxied.
        token: null,
        tokenExpiresAt: null,
        user: currentUser
          ? { id: currentUser.id, name: currentUser.fullName || currentUser.firstName || '', imageUrl: currentUser.imageUrl }
          : null,
        protocol: HOST_BRIDGE_PROTOCOL,
        designTokens: readPlatformDesignTokens(),
        surface: opts.surface,
        modal: opts.modal,
      },
    });
  }, [post]);

  useEffect(() => {
    const respond = (id: string, result: { ok: true; payload: unknown; transfer?: Transferable[] } | { ok: false; message: string }) => {
      if (result.ok) {
        post({ type: 'weldapp:response', id, ok: true, payload: result.payload }, result.transfer);
      } else {
        post({ type: 'weldapp:response', id, ok: false, error: { message: result.message } });
      }
    };

    const methods = createBridgeMethods({ live, proxyFetch, mintLegacyToken, setPendingConfirm, setPendingModal });

    const handleRequest = async (id: string, method: string, payload: unknown) => {
      const { options: opts } = live.current;
      try {
        const handler = methods.get(method);
        if (!handler) throw new BridgeRequestError(`Unknown method: ${method}`);
        const result = await handler(payload, opts);
        respond(id, { ok: true, payload: result.payload, transfer: result.transfer });
        result.afterRespond?.();
      } catch (error) {
        respond(id, { ok: false, message: error instanceof Error ? error.message : 'Request failed' });
      }
    };

    const handleMessage = (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || event.source !== iframeWindow) return;
      if (targetOrigin !== '*' && event.origin !== targetOrigin) return;

      const data = event.data as IncomingWeldAppMessage | undefined;
      if (!data || typeof data !== 'object' || !('type' in data)) return;

      if (data.type === 'weldapp:ready') {
        sendInit();
        return;
      }
      if (data.type === 'weldapp:request' && typeof data.id === 'string') {
        void handleRequest(data.id, data.method, data.payload);
        return;
      }
      if (data.type === 'weldapp:notify') {
        if (data.event === 'mounted') {
          live.current.options.onMounted();
        } else if (data.event === 'shortcut') {
          const shortcut = parseShortcut(data.payload);
          if (shortcut) {
            // Replay on the platform document so its own Cmd+K / Cmd+J
            // handlers run exactly as if the key was pressed outside.
            document.dispatchEvent(new KeyboardEvent('keydown', { ...shortcut, bubbles: true, cancelable: true }));
          }
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [iframeRef, targetOrigin, post, sendInit, proxyFetch, mintLegacyToken]);

  // Theme: push the value, then the recomputed design tokens once the
  // platform has applied its theme class.
  useEffect(() => {
    post({ type: 'weldapp:event', event: 'theme', payload: { value: theme } });
    const frame = requestAnimationFrame(() => {
      post({ type: 'weldapp:event', event: 'designTokens', payload: { value: readPlatformDesignTokens() } });
    });
    return () => cancelAnimationFrame(frame);
  }, [theme, post]);

  useEffect(() => {
    post({ type: 'weldapp:event', event: 'locale', payload: { value: language } });
  }, [language, post]);

  useEffect(() => {
    post({ type: 'weldapp:event', event: 'route', payload: { value: options.path } });
  }, [options.path, post]);

  // Unmount: settle interactive requests so nothing waits on a dead frame.
  useEffect(
    () => () => {
      live.current.pendingModal?.resolve({ dismissed: true });
    },
    [],
  );

  const closeConfirm = (confirmed: boolean) => {
    pendingConfirm?.resolve(confirmed);
    setPendingConfirm(null);
  };

  const closeModal = (outcome: { dismissed: boolean; result?: unknown }) => {
    pendingModal?.resolve(outcome);
    setPendingModal(null);
  };

  return (
    <>
      {pendingConfirm ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) closeConfirm(false);
          }}
          title={pendingConfirm.request.title}
          description={pendingConfirm.request.description ?? ''}
          confirmLabel={pendingConfirm.request.confirmLabel ?? t.common.actions.confirm}
          cancelLabel={pendingConfirm.request.cancelLabel ?? t.common.actions.cancel}
          variant={pendingConfirm.request.destructive ? 'destructive' : 'default'}
          onConfirm={() => closeConfirm(true)}
        />
      ) : null}
      {pendingModal ? (
        <WeldAppModal
          appCode={options.appCode}
          appName={options.appName}
          frameSrc={options.frameSrc}
          sandbox={options.sandbox}
          targetOrigin={targetOrigin}
          usesPlatformSession={options.usesPlatformSession}
          request={pendingModal.request}
          onClose={closeModal}
        />
      ) : null}
    </>
  );
}

const MODAL_SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-2xl',
  lg: 'sm:max-w-4xl',
  xl: 'sm:max-w-6xl',
};

/**
 * A second instance of the app, rendered at `request.path` inside a native
 * platform dialog (full-viewport backdrop, Escape to close).
 */
function WeldAppModal({
  appCode,
  appName,
  frameSrc,
  sandbox,
  targetOrigin,
  usesPlatformSession,
  request,
  onClose,
}: {
  appCode: string;
  appName: string;
  frameSrc: string;
  sandbox: string;
  targetOrigin: string;
  usesPlatformSession: boolean;
  request: OpenModalRequest;
  onClose: (outcome: { dismissed: boolean; result?: unknown }) => void;
}) {
  const { resolvedTheme } = useTheme();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [mounted, setMounted] = useState(false);
  const [src] = useState(() => bootstrapFrameSrc(frameSrc, resolvedTheme === 'dark' ? 'dark' : 'light', request.path));
  const title = request.title ?? appName;

  const overlays = useBridgeHost({
    appCode,
    appName,
    iframeRef,
    targetOrigin,
    usesPlatformSession,
    path: request.path,
    surface: 'modal',
    modal: { title: request.title, params: request.params },
    frameSrc,
    sandbox,
    onMounted: () => setMounted(true),
    onCloseModal: (result) => onClose({ dismissed: false, result }),
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose({ dismissed: true });
      }}
    >
      <DialogContent className={cn('p-0 gap-0 overflow-hidden', MODAL_SIZE_CLASS[request.size])}>
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="relative h-[70vh] border-t bg-background">
          <iframe
            ref={iframeRef}
            src={src}
            title={title}
            sandbox={sandbox}
            className={cn('w-full h-full border-0 bg-background transition-opacity', mounted ? 'opacity-100' : 'opacity-0')}
            onLoad={() => window.setTimeout(() => setMounted(true), LEGACY_MOUNT_FALLBACK_MS)}
          />
        </div>
        {overlays}
      </DialogContent>
    </Dialog>
  );
}

