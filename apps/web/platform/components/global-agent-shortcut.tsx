
import { lazy, Suspense, useEffect, useState, useCallback } from 'react';
import { usePathname } from '@/lib/router';
import { useMobileNav } from '@/contexts/mobile-nav-context';
import { useWeldAgentSafe } from '@/components/weldagent-wrapper';
import { loadWeldAgentPanel } from '@/components/weldagent/lazy-panel';

// Lazy-loaded — the panel body (~140 KB of weldagent code) only ships when
// the user opens the agent. The same shared loader (`loadWeldAgentPanel`) backs
// the React.lazy boundary, the idle prefetch below, and the open-gate in
// `use-weldagent-drawer-open.ts`, so the chunk is fetched exactly once and the
// first open can wait for it.
const WeldAgentPanel = lazy(() =>
  loadWeldAgentPanel().then((m) => ({ default: m.WeldAgentPanel })),
);

// Kick off the chunk download once the browser is idle after first paint. This
// keeps it out of the initial critical waterfall (the chunk isn't requested
// during page load) while ensuring it's cached before the user opens the panel.
function prefetchWeldAgentPanel() {
  loadWeldAgentPanel().catch(() => {
    // Speculative prefetch — failures are retried on the real open.
  });
}

const DEFAULT_WELDAGENT_WIDTH = 400;

export function GlobalAgentShortcut() {
  const pathname = usePathname();
  const { showWeldAgent, setShowWeldAgent, toggleWeldAgent, weldAgentWidth, setWeldAgentWidth, weldAgentLastPath, setWeldAgentLastPath, weldAgentPrefill, setWeldAgentPrefill, weldAgentSkipAnimation, setWeldAgentSkipAnimation } = useMobileNav();
  const weldAgentContext = useWeldAgentSafe();
  const [forceNewConversation, setForceNewConversation] = useState(false);

  // Warm the lazy panel chunk during idle time so the first open is instant.
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(prefetchWeldAgentPanel, { timeout: 3000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(prefetchWeldAgentPanel, 1500);
    return () => clearTimeout(t);
  }, []);

  // Determine if we should force a new conversation when opening
  useEffect(() => {
    if (showWeldAgent) {
      // First time opening on this page, or path changed since last open
      if (!weldAgentLastPath) {
        // First time opening - create new conversation and reset width
        setForceNewConversation(true);
        setWeldAgentWidth(DEFAULT_WELDAGENT_WIDTH);
        setWeldAgentLastPath(pathname);
      } else if (weldAgentLastPath !== pathname) {
        // Path changed - create new conversation and reset width
        setForceNewConversation(true);
        setWeldAgentWidth(DEFAULT_WELDAGENT_WIDTH);
        setWeldAgentLastPath(pathname);
      }
      // If same path, keep existing conversation and width (forceNewConversation stays false)
    }
  }, [showWeldAgent, pathname, weldAgentLastPath, setWeldAgentLastPath, setWeldAgentWidth]);

  // Reset state when path changes while panel is closed
  useEffect(() => {
    if (!showWeldAgent && weldAgentLastPath && weldAgentLastPath !== pathname) {
      // Path changed while panel was closed - clear the last path and reset width so next open starts fresh
      setWeldAgentLastPath(null);
      setWeldAgentWidth(DEFAULT_WELDAGENT_WIDTH);
    }
  }, [pathname, showWeldAgent, weldAgentLastPath, setWeldAgentLastPath, setWeldAgentWidth]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + J to toggle agent
      if (e.key === 'j' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleWeldAgent();
      }
      // Escape to close
      if (e.key === 'Escape' && showWeldAgent) {
        setShowWeldAgent(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showWeldAgent, toggleWeldAgent, setShowWeldAgent]);

  // Callback when new conversation is created - reset the flag
  const handleNewConversationCreated = useCallback(() => {
    setForceNewConversation(false);
  }, []);

  const handlePrefillConsumed = useCallback(() => {
    setWeldAgentPrefill(null);
  }, [setWeldAgentPrefill]);

  // Only mount the (lazy) panel once the user has opened it — keeps the
  // chunk out of the initial network waterfall for users who never use it.
  if (!showWeldAgent) return null;

  return (
    <Suspense fallback={null}>
      <WeldAgentPanel
        isOpen={showWeldAgent}
        onClose={() => setShowWeldAgent(false)}
        moduleKey="general"
        entityContext={weldAgentContext?.entityContext ?? undefined}
        width={weldAgentWidth}
        onWidthChange={setWeldAgentWidth}
        disableAnimation={weldAgentSkipAnimation}
        forceNewConversation={forceNewConversation}
        onNewConversationCreated={handleNewConversationCreated}
        prefillText={weldAgentPrefill}
        onPrefillConsumed={handlePrefillConsumed}
      />
    </Suspense>
  );
}
