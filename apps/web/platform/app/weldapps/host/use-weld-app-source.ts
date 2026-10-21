import { useMemo } from 'react';
import { useInstalledUserApps, useUserAppDevSession } from '@/hooks/queries/use-user-apps-queries';
import { getBundleOrigin, isolateCommunityApps } from './frame-src';
import { acceptPreviewSession, iframeSandbox, iframeTargetOrigin, type FrameKind } from './preview';
import { useUserAppBundleLink } from './use-bundle-link';

// Re-exported for the callers that always imported them from here.
export { APP_API_BASE, bootstrapFrameSrc } from './frame-src';

/**
 * Resolve what to load for `appCode`: the installed app row, and the iframe
 * source — the developer's `weld app dev` preview when one is active (and
 * acceptable, see `acceptPreviewSession`), else the published bundle, loaded
 * through the link the API mints (plain for public apps, signed otherwise).
 *
 * `pollDevSession: false` keeps the preview session from being polled (used by
 * kept-alive frames that are not currently shown); the last known session is
 * still used.
 */
export function useWeldAppSource(appCode: string | undefined, options: { pollDevSession?: boolean } = {}) {
  const { data: installedApps, isLoading: installedLoading } = useInstalledUserApps();
  const { data: devSession } = useUserAppDevSession(appCode, { poll: options.pollDevSession });

  const app = installedApps?.find((a) => a.appCode === appCode);
  const preview = useMemo(() => acceptPreviewSession(devSession), [devSession]);
  const previewUrl = preview?.url ?? null;
  const kind: FrameKind = preview ? 'preview' : 'bundle';

  const bundle = useUserAppBundleLink(appCode, { enabled: Boolean(app) && !preview });
  const iframeSrc = previewUrl ?? bundle.src ?? '';

  /**
   * First-party apps (and the legacy weldcommerce hosted app) act with
   * the member's platform session against app-api; community apps go
   * through the scoped gateway to external-api.
   */
  const usesPlatformSession = app?.publisherType === 'weldsuite' || appCode === 'weldcommerce';
  // A community bundle shares its origin with the others (and the API) unless
  // every app has its own, so it may be rendered in an opaque origin.
  const isolated =
    kind === 'bundle' &&
    !usesPlatformSession &&
    isolateCommunityApps() &&
    !(appCode ? getBundleOrigin(appCode).perApp : false);

  return useMemo(
    () => ({
      app,
      isLoading: installedLoading || (Boolean(app) && !preview && bundle.isLoading),
      /** The bundle link could not be minted or is unusable; the frame cannot load. */
      bundleError: Boolean(app) && !preview && bundle.isError && !bundle.src,
      refreshBundle: bundle.refresh,
      /** Epoch ms at which a signed bundle link expires; null for plain links and previews. */
      bundleExpiresAtMs: preview ? null : bundle.expiresAtMs,
      kind,
      previewUrl,
      iframeSrc,
      /** The exact origin the frame is pinned to (null while there is nothing to load). */
      targetOrigin: iframeTargetOrigin(iframeSrc),
      isolated,
      sandbox: iframeSandbox({ kind, isolated }),
      usesPlatformSession,
    }),
    [
      app,
      installedLoading,
      preview,
      bundle.isLoading,
      bundle.isError,
      bundle.src,
      bundle.refresh,
      bundle.expiresAtMs,
      kind,
      previewUrl,
      iframeSrc,
      isolated,
      usesPlatformSession,
    ],
  );
}
