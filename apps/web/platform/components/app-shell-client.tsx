
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { usePathname } from '@/lib/router';
import { isWorkspaceScopedPath } from '@/lib/workspace-url';
import { useWorkspaceUrlGate, type WorkspaceUrlGate } from '@/components/workspace-url-gate';
import { WorkspaceLinkProblem } from '@/components/workspace/workspace-link-problem';
import { useAuth, useOrganizationList } from '@clerk/clerk-react';
import { ComposeProvider } from '@/contexts/compose-context';
import { PinnedNoteProvider } from '@/contexts/pinned-note-context';
import { CallProvider } from '@/contexts/call-context';
import { FloatingVideoProvider } from '@/contexts/floating-video-context';
import { FloatingCallProvider } from '@/contexts/floating-call-context';

// Globally-mounted weldcrm overlays are lazy-loaded — they collectively pull
// ~80 KB of weldcrm code into the shell otherwise.
const GlobalPinnedNote = lazy(() =>
  import('@/components/weldcrm/notes/global-pinned-note').then((m) => ({ default: m.GlobalPinnedNote })),
);
const GlobalCallPanel = lazy(() =>
  import('@/components/weldcrm/calls/global-call-panel').then((m) => ({ default: m.GlobalCallPanel })),
);
const GlobalFloatingVideo = lazy(() =>
  import('@/components/weldcrm/calls/global-floating-video').then((m) => ({ default: m.GlobalFloatingVideo })),
);
const GlobalFloatingCall = lazy(() =>
  import('@/components/weldcrm/calls/global-floating-call').then((m) => ({ default: m.GlobalFloatingCall })),
);
import { PlatformShell } from '@/components/layout/platform-shell';
import { CommandPalette } from '@/components/layout/command-palette';
import { WorkspaceLockGate } from '@/components/billing/workspace-lock-gate';
import { ManagedWorkspaceBanner } from '@/components/partner/managed-workspace-banner';
import { ActiveCallProvider } from '@/contexts/active-call-context';
import { WeldChatCallProvider } from '@/contexts/weldchat-call-context';
import { WeldMeetCallProvider } from '@/contexts/weldmeet-call-context';
import { EntitySheetHost } from '@/components/entity-sheet';
import { DesktopNotificationBridge } from '@/components/desktop/desktop-notification-bridge';
import {
  clearPendingOrganization,
  peekPendingOrganization,
  resolveOrganizationToActivate,
} from '@/lib/pending-organization';

// Globally-mounted overlays are lazy-loaded — they each pull big modules
// (weldchat ~500 KB, weldmail compose ~50 KB, weldmeet meeting overlay)
// that otherwise land in the main chunk.
const WeldAppFrameLayer = lazy(() =>
  import('@/app/weldapps/host/frame-layer').then((m) => ({ default: m.WeldAppFrameLayer })),
);
const FloatingComposePanel = lazy(() =>
  import('@/app/weldmail/components/floating-compose-panel').then((m) => ({ default: m.FloatingComposePanel })),
);
const CallOverlay = lazy(() =>
  import('@/app/weldchat/components/call-overlay').then((m) => ({ default: m.CallOverlay })),
);
// One dialog for every "leave this call to join another" question, chat or meeting.
const CallSwitchDialog = lazy(() =>
  import('@/components/call-switch-dialog').then((m) => ({ default: m.CallSwitchDialog })),
);
const PiPCallWidget = lazy(() =>
  import('@/app/weldchat/components/pip-call-widget').then((m) => ({ default: m.PiPCallWidget })),
);
const IncomingCallToast = lazy(() =>
  import('@/app/weldchat/components/incoming-call-toast').then((m) => ({ default: m.IncomingCallToast })),
);
const MeetingOverlay = lazy(() =>
  import('@/app/weldmeet/components/meeting-overlay').then((m) => ({ default: m.MeetingOverlay })),
);
const GlobalTimerWidget = lazy(() =>
  import('@/components/weldflow/timer/global-timer-widget').then((m) => ({ default: m.GlobalTimerWidget })),
);
const MeetingPiPWidget = lazy(() =>
  import('@/app/weldmeet/components/meeting-pip-widget').then((m) => ({ default: m.MeetingPiPWidget })),
);

/**
 * /auth, /onboarding, /invite and /w/{workspace} links bootstrap their own org
 * context; the public /w9 form has none at all.
 */
function bootstrapsOwnOrg(pathname: string): boolean {
  return (
    pathname.startsWith('/auth/') ||
    pathname === '/onboarding' ||
    pathname.startsWith('/invite') ||
    pathname.startsWith('/w/') ||
    pathname.startsWith('/w9/')
  );
}

/**
 * Reload the same page, so a /w/{workspace} link that switched org still lands
 * where it pointed. The reload hydrates from the new org's own persisted cache
 * (FE-014).
 */
function reloadIntoNewOrg() {
  window.location.reload();
}

/**
 * `?embedded=1` (or the persisted `window.name` flag) marks a page iframed
 * inside another panel. Persist the flag in `window.name` (scoped per browsing
 * context — survives in-iframe navigation but doesn't leak to the parent tab)
 * so clicking project tabs inside the iframe (which loses the query string)
 * keeps the embedded mode active.
 */
function detectEmbeddedRoute(): boolean {
  if (typeof window === 'undefined') return false;
  const hasEmbeddedParam = new URLSearchParams(window.location.search).get('embedded') === '1';
  const isEmbedded = hasEmbeddedParam || window.name === 'weldsuite-embedded';
  if (hasEmbeddedParam && window.name !== 'weldsuite-embedded') {
    window.name = 'weldsuite-embedded';
  }
  return isEmbedded;
}

/** Routes rendered without PlatformShell (no sidebar). */
function isMinimalPath(pathname: string): boolean {
  // Pages outside a workspace (sign-in, onboarding, invites, the W-9 form,
  // `/preview`, a `/w/{workspace}` link that only resolves and redirects, …).
  return !isWorkspaceScopedPath(pathname) || /^\/builder\/[^/]+$/.test(pathname);
}

/**
 * What the shell renders instead of the page while a `/w/{workspace}` URL is
 * unsettled (FE-013): nothing while the tab may still be in the previous
 * workspace (its queries would use that token), the workspace list when the
 * URL's workspace can't be opened. `undefined` renders the page.
 */
function renderWorkspaceUrlHold(gate: WorkspaceUrlGate): React.ReactElement | null | undefined {
  if (gate.status === 'blocked') return null;
  if (gate.status === 'not-found' || gate.status === 'error') {
    return <WorkspaceLinkProblem status={gate.status} memberships={gate.memberships} target={gate.target} />;
  }
  return undefined;
}

interface AppShellClientProps {
  children: React.ReactNode;
}

export function AppShellClient({ children }: Readonly<AppShellClientProps>) {
  const pathname = usePathname();
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const {
    isLoaded: orgListLoaded,
    userMemberships,
    setActive,
  } = useOrganizationList({ userMemberships: true });
  const orgActivationRef = useRef(false);
  // Captured once per page load so a just-created workspace survives the
  // reload even if Clerk's session still has the previous org (or none).
  const [pendingOrgId] = useState(() => peekPendingOrganization());
  // A `/w/{workspace}` URL decides which org this tab is in (FE-013).
  const workspaceUrl = useWorkspaceUrlGate(pathname);

  // Activate the right org when Clerk hasn't (or has the wrong one).
  // Creating a workspace from the user menu stashes the new org id in
  // sessionStorage; that pending id must win over memberships[0], which is
  // the *old* workspace. The previous behaviour activated the first
  // membership whenever orgId was missing, so the reload after create
  // dropped the user back into the workspace they just left.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    if (bootstrapsOwnOrg(pathname) || workspaceUrl.ownsActivation) return;
    if (!orgListLoaded || !setActive || orgActivationRef.current) return;

    const firstOrgId = userMemberships?.data?.[0]?.organization?.id;
    const targetOrgId = resolveOrganizationToActivate({
      orgId,
      pendingOrgId,
      firstOrgId,
    });

    if (!targetOrgId) {
      if (pendingOrgId && pendingOrgId === orgId) {
        clearPendingOrganization();
      }
      return;
    }

    orgActivationRef.current = true;
    const switchingFromActiveOrg = Boolean(orgId) && orgId !== targetOrgId;
    setActive({ organization: targetOrgId })
      .then(() => {
        clearPendingOrganization();
        // Session already had a different org, so this page hydrated against
        // the wrong workspace. Reload once the new org is active.
        if (switchingFromActiveOrg) reloadIntoNewOrg();
      })
      .catch(() => {
        orgActivationRef.current = false;
      });
  }, [
    isLoaded,
    isSignedIn,
    orgId,
    orgListLoaded,
    userMemberships?.data,
    setActive,
    pathname,
    pendingOrgId,
    workspaceUrl.ownsActivation,
  ]);

  // `?embedded=1` strips the platform shell (workspace + module sidebars) so a
  // page can be iframed inside another panel as if it were standalone — used
  // by the WeldChat project detail "Expand" overlay so users see the full
  // weldflow project page without duplicate chrome.
  //
  // We also persist the flag in `window.name` (scoped per browsing context —
  // survives in-iframe navigation but doesn't leak to the parent tab) so
  // clicking project tabs inside the iframe (which loses the query string)
  // keeps the embedded mode active.
  const isEmbeddedRoute = detectEmbeddedRoute();

  // Determine if this is a minimal route (no PlatformShell with sidebar)
  const isMinimalRoute = isEmbeddedRoute || isMinimalPath(pathname);

  // The URL's workspace isn't the tab's yet, or can't be (embedded pages
  // included; pages outside a workspace never get here, the gate is off).
  const workspaceUrlHold = renderWorkspaceUrlHold(workspaceUrl);
  if (workspaceUrlHold !== undefined) return workspaceUrlHold;

  if (isMinimalRoute) {
    // Embedded routes need an h-screen / flex wrapper so the weldflow
    // (and other module) layouts — which use `h-full` — fill the iframe
    // viewport. Without this they collapse to content height and leave
    // empty space below.
    if (isEmbeddedRoute) {
      return (
        <div className="h-screen w-full flex flex-col overflow-hidden">
          <CommandPalette />
          {children}
        </div>
      );
    }
    return <>{children}</>;
  }

  // Redirect unauthenticated users to login for protected routes
  if (!isLoaded) {
    return null;
  }

  if (!isSignedIn) {
    // The browser path, so signing in returns to the workspace the URL names.
    const here = window.location.pathname + window.location.search;
    window.location.href = `/auth/login?callbackUrl=${encodeURIComponent(here)}`;
    return null;
  }

  // Wait while we activate a just-created workspace (or an org-less session
  // that still has memberships). Don't flash the previous workspace, and
  // don't bounce to /onboarding while that activation is in flight.
  const activatingPendingOrg = Boolean(pendingOrgId && pendingOrgId !== orgId);
  if (!orgId || activatingPendingOrg) {
    if (!orgListLoaded) return null;
    if (activatingPendingOrg) return null;
    if ((userMemberships?.data?.length ?? 0) > 0) return null;
    window.location.href = '/onboarding';
    return null;
  }

  // Full platform shell with module-specific providers
  return (
    <ComposeProvider>
      <PinnedNoteProvider>
        <CallProvider>
          <FloatingVideoProvider>
            <FloatingCallProvider>
              {/* Outermost of the call providers: WeldChat wraps WeldMeet, so
                  neither can see the other's call. Both register their live
                  call here to keep a user in at most one at a time. */}
              <ActiveCallProvider>
                <WeldChatCallProvider>
                  <WeldMeetCallProvider>
                    {/* Post-trial paywall. Wraps the ENTIRE shell (sidebar +
                        content + all the global overlays below) so a locked
                        workspace renders nothing but the full-screen lockout
                        card — including `/settings`, which isn't in
                        AppShellClient's minimal-route allowlist above and so
                        would otherwise stay reachable. Auth/onboarding/invite
                        routes short-circuit earlier (isMinimalRoute) and never
                        reach this gate. */}
                    <WorkspaceLockGate>
                      <CommandPalette />
                      <DesktopNotificationBridge />
                      {/* Read-only / partner past-due notice for managed workspaces. */}
                      <ManagedWorkspaceBanner />
                      <PlatformShell>
                        {children}
                        <Suspense fallback={null}>
                          <FloatingComposePanel />
                          <GlobalPinnedNote />
                          {/* Running time-tracking timer — mounted here so it
                              stays visible and stoppable from any module. */}
                          <GlobalTimerWidget />
                          <GlobalCallPanel />
                          <GlobalFloatingCall />
                          <GlobalFloatingVideo />
                          <CallOverlay />
                          <PiPCallWidget />
                          <CallSwitchDialog />
                          <IncomingCallToast />
                          <MeetingOverlay />
                          {/* Minimized meeting widget — bottom-right PiP shown
                              when a meeting is connected but the user has
                              navigated off the meeting page (or minimized). */}
                          <MeetingPiPWidget />
                          <EntitySheetHost />
                          {/* Kept-alive WeldApp iframes, positioned over the
                              slot the /apps/{code} page reserves (see
                              app/weldapps/host/frame-store.ts). */}
                          <WeldAppFrameLayer />
                          {/* Object panels now render in-flow as a slot inside
                              PlatformShell's content card (see ObjectPanelHost) —
                              still within this provider scope, so panel bodies
                              keep inheriting CallProvider / ComposeProvider / etc. */}
                        </Suspense>
                      </PlatformShell>
                    </WorkspaceLockGate>
                  </WeldMeetCallProvider>
                </WeldChatCallProvider>
              </ActiveCallProvider>
            </FloatingCallProvider>
          </FloatingVideoProvider>
        </CallProvider>
      </PinnedNoteProvider>
    </ComposeProvider>
  );
}
