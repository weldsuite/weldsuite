import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@clerk/clerk-react';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@weldsuite/ui/lib/utils';
import { useTheme } from '@/hooks/use-theme';
import { LEGACY_MOUNT_FALLBACK_MS, useBridgeHost } from './bridge-host';
import {
  clearWeldAppFrames,
  resetFrameStatus,
  updateFrameStatus,
  useWeldAppFrames,
  useWeldAppFrameSlot,
  useWeldAppFrameStatus,
} from './frame-store';
import { bootstrapFrameSrc, useWeldAppSource } from './use-weld-app-source';

interface SlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** The slot's computed border-radius, so the frame matches the content card. */
  radius: string;
}

/** Size used to lay out preloaded apps before they have ever been shown. */
const OFFSCREEN_RECT: SlotRect = { left: -10_000, top: 0, width: 1280, height: 800, radius: '0px' };

/** Fallback re-measure for position-only shifts ResizeObserver cannot see. */
const REMEASURE_INTERVAL_MS = 500;

function sameRect(a: SlotRect | null, b: SlotRect | null): boolean {
  return (
    !!a &&
    !!b &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height &&
    a.radius === b.radius
  );
}

/** Track the viewport rect of the slot element the current page reserved. */
function useSlotRect(element: HTMLElement | null): SlotRect | null {
  const [rect, setRect] = useState<SlotRect | null>(null);

  useLayoutEffect(() => {
    if (!element) {
      setRect(null);
      return;
    }
    const measure = () => {
      const r = element.getBoundingClientRect();
      const next = {
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
        radius: getComputedStyle(element).borderRadius,
      };
      setRect((prev) => (sameRect(prev, next) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(document.documentElement);
    window.addEventListener('resize', measure);
    const interval = window.setInterval(measure, REMEASURE_INTERVAL_MS);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.clearInterval(interval);
    };
  }, [element]);

  return rect;
}

/**
 * Keep-alive host for WeldApp iframes. Mounted once in the platform shell;
 * see `frame-store.ts` for why frames live here instead of in the page.
 */
export function WeldAppFrameLayer() {
  const frames = useWeldAppFrames();
  const slot = useWeldAppFrameSlot();
  const rect = useSlotRect(slot?.element ?? null);
  const { orgId, isSignedIn } = useAuth();

  // A frame belongs to one workspace + session: tear everything down when
  // either changes. Compare against the previous value so the first render
  // does not wipe a slot the page has just attached.
  const identity = `${isSignedIn ? 'in' : 'out'}:${orgId ?? ''}`;
  const previousIdentity = useRef(identity);
  useEffect(() => {
    if (previousIdentity.current !== identity) {
      previousIdentity.current = identity;
      clearWeldAppFrames();
    }
  }, [identity]);

  if (typeof document === 'undefined' || frames.length === 0) return null;

  return createPortal(
    <>
      {frames.map((appCode) => {
        const active = slot?.appCode === appCode && rect !== null;
        return (
          <PooledFrame
            key={`${identity}:${appCode}`}
            appCode={appCode}
            active={active}
            rect={active ? rect : null}
            path={slot?.appCode === appCode ? slot.path : null}
          />
        );
      })}
    </>,
    document.body,
  );
}

function PooledFrame({
  appCode,
  active,
  rect,
  path,
}: {
  appCode: string;
  active: boolean;
  rect: SlotRect | null;
  /** Current app-relative path while shown; null keeps the last one. */
  path: string | null;
}) {
  const source = useWeldAppSource(appCode);
  const status = useWeldAppFrameStatus(appCode);
  const { resolvedTheme } = useTheme();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [lastPath, setLastPath] = useState(path ?? '/');
  useEffect(() => {
    if (path !== null) setLastPath(path);
  }, [path]);
  const effectivePath = path ?? lastPath;

  const [lastRect, setLastRect] = useState<SlotRect | null>(rect);
  useEffect(() => {
    if (rect) setLastRect(rect);
  }, [rect]);

  // Theme + route go into the first src only; later changes travel over the
  // bridge, so navigating never reloads the app. A new base src (dev
  // session started/stopped) is a new app instance.
  const [bootstrapped, setBootstrapped] = useState<{ base: string; src: string } | null>(null);
  const base = source.iframeSrc;
  if (base && bootstrapped?.base !== base) {
    setBootstrapped({ base, src: bootstrapFrameSrc(base, resolvedTheme === 'dark' ? 'dark' : 'light', effectivePath) });
  }
  useEffect(() => {
    resetFrameStatus(appCode);
  }, [appCode, base]);

  const overlays = useBridgeHost({
    appCode,
    appName: source.app?.name ?? appCode,
    iframeRef,
    targetOrigin: source.targetOrigin,
    usesPlatformSession: source.usesPlatformSession,
    path: effectivePath,
    surface: 'page',
    frameSrc: base,
    sandbox: source.sandbox,
    onMounted: () => updateFrameStatus(appCode, { mounted: true }),
    onBreadcrumbs: (breadcrumbs) => updateFrameStatus(appCode, { breadcrumbs }),
    onDirty: (dirty) => updateFrameStatus(appCode, { dirty }),
  });

  // Not installed (or uninstalled while alive): nothing to host.
  if (!source.app || !bootstrapped) return null;

  const box = rect ?? lastRect ?? OFFSCREEN_RECT;
  const style: CSSProperties = {
    position: 'fixed',
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    borderRadius: box.radius,
    overflow: 'hidden',
    visibility: active ? 'visible' : 'hidden',
    pointerEvents: active ? 'auto' : 'none',
  };

  return (
    <div style={style} className="z-[5] bg-background" data-weldapp-frame={appCode} aria-hidden={!active}>
      <iframe
        key={bootstrapped.src}
        ref={iframeRef}
        src={bootstrapped.src}
        title={source.app.name}
        sandbox={source.sandbox}
        className={cn(
          'w-full h-full border-0 bg-background transition-opacity duration-150',
          status.mounted ? 'opacity-100' : 'opacity-0',
        )}
        onLoad={() => {
          window.setTimeout(() => updateFrameStatus(appCode, { mounted: true }), LEGACY_MOUNT_FALLBACK_MS);
        }}
      />
      {status.mounted ? null : <FrameSkeleton />}
      {active ? overlays : null}
    </div>
  );
}

/** Neutral page skeleton in platform styling while the app boots. */
function FrameSkeleton() {
  return (
    <div className="absolute inset-0 flex flex-col gap-4 p-6 bg-background" role="status" aria-busy="true">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-80" />
      <div className="mt-2 flex flex-col gap-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-3/4" />
      </div>
    </div>
  );
}
