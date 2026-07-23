
import { Suspense, lazy, useEffect, useRef } from 'react';
import { usePathname } from '@/lib/router';
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
import { WorkspaceLockGate } from '@/components/billing/workspace-lock-gate';
import { WeldChatCallProvider } from '@/contexts/weldchat-call-context';
import { WeldMeetCallProvider } from '@/contexts/weldmeet-call-context';
import { EntitySheetHost } from '@/components/entity-sheet';

// Globally-mounted overlays are lazy-loaded — they each pull big modules
// (weldchat ~500 KB, weldmail compose ~50 KB, weldmeet meeting overlay)
// that otherwise land in the main chunk.
const FloatingComposePanel = lazy(() =>
  import('@/app/weldmail/components/floating-compose-panel').then((m) => ({ default: m.FloatingComposePanel })),
);
const CallOverlay = lazy(() =>
  import('@/app/weldchat/components/call-overlay').then((m) => ({ default: m.CallOverlay })),
);
const SwitchCallDialog = lazy(() =>
  import('@/app/weldchat/components/call-overlay').then((m) => ({ default: m.SwitchCallDialog })),
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

interface AppShellClientProps {
  children: React.ReactNode;
}

export function AppShellClient({ children }: AppShellClientProps) {
  const pathname = usePathname();
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const {
    isLoaded: orgListLoaded,
    userMemberships,
    setActive,
  } = useOrganizationList({ userMemberships: true });
  const orgActivationRef = useRef(false);

  // When the user is signed in but Clerk hasn't surfaced an active org yet
  // (notably right after creating a workspace from the user menu), activate
  // their first membership IN PLACE. The old behaviour hard-redirected to
  // /onboarding, whose own auto-activate effect then redirected back to `/`
  // — and while Clerk's session was still settling the two full-page
  // redirects ping-ponged, reloading the page roughly once a second.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || orgId) return;
    // /auth, /onboarding and /invite bootstrap their own org context.
    if (
      pathname.startsWith('/auth/') ||
      pathname === '/onboarding' ||
      pathname.startsWith('/invite')
    ) {
      return;
    }
    if (!orgListLoaded || !setActive) return;
    const firstOrgId = userMemberships?.data?.[0]?.organization?.id;
    if (!firstOrgId || orgActivationRef.current) return;
    orgActivationRef.current = true;
    setActive({ organization: firstOrgId }).catch(() => {
      orgActivationRef.current = false;
    });
  }, [isLoaded, isSignedIn, orgId, orgListLoaded, userMemberships?.data, setActive, pathname]);

  // `?embedded=1` strips the platform shell (workspace + module sidebars) so a
  // page can be iframed inside another panel as if it were standalone — used
  // by the WeldChat project detail "Expand" overlay so users see the full
  // weldflow project page without duplicate chrome.
  //
  // We also persist the flag in `window.name` (scoped per browsing context —
  // survives in-iframe navigation but doesn't leak to the parent tab) so
  // clicking project tabs inside the iframe (which loses the query string)
  // keeps the embedded mode active.
  const isEmbeddedRoute =
    typeof window !== 'undefined' &&
    (new URLSearchParams(window.location.search).get('embedded') === '1' ||
      window.name === 'weldsuite-embedded');
  if (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('embedded') === '1' &&
    window.name !== 'weldsuite-embedded'
  ) {
    window.name = 'weldsuite-embedded';
  }

  // Determine if this is a minimal route (no PlatformShell with sidebar)
  const isMinimalRoute =
    isEmbeddedRoute ||
    pathname.startsWith('/preview') ||
    /^\/builder\/[^/]+$/.test(pathname) ||
    pathname === '/welcome' ||
    pathname.startsWith('/auth/') ||
    pathname === '/onboarding' ||
    pathname === '/invite' ||
    pathname.startsWith('/invite/') ||
    pathname === '/call-room';

  if (isMinimalRoute) {
    // Embedded routes need an h-screen / flex wrapper so the weldflow
    // (and other module) layouts — which use `h-full` — fill the iframe
    // viewport. Without this they collapse to content height and leave
    // empty space below.
    if (isEmbeddedRoute) {
      return (
        <div className="h-screen w-full flex flex-col overflow-hidden">
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
    window.location.href = `/auth/login?callbackUrl=${encodeURIComponent(pathname)}`;
    return null;
  }

  // No active org yet. If the user actually has memberships, the effect
  // above is activating one in place — wait for orgId to populate rather
  // than bouncing to /onboarding (which would loop). Only send genuinely
  // org-less users to onboarding.
  if (!orgId) {
    if (!orgListLoaded) return null;
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
                        <SwitchCallDialog />
                        <IncomingCallToast />
                        <MeetingOverlay />
                        {/* Minimized meeting widget — bottom-right PiP shown
                            when a meeting is connected but the user has
                            navigated off the meeting page (or minimized). */}
                        <MeetingPiPWidget />
                        <EntitySheetHost />
                        {/* Object panels now render in-flow as a slot inside
                            PlatformShell's content card (see ObjectPanelHost) —
                            still within this provider scope, so panel bodies
                            keep inheriting CallProvider / ComposeProvider / etc. */}
                      </Suspense>
                    </PlatformShell>
                  </WorkspaceLockGate>
                </WeldMeetCallProvider>
              </WeldChatCallProvider>
            </FloatingCallProvider>
          </FloatingVideoProvider>
        </CallProvider>
      </PinnedNoteProvider>
    </ComposeProvider>
  );
}
