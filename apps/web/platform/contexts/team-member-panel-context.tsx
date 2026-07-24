/**
 * Platform-wide team-member panel.
 *
 * A single right-docked panel mounted at the app-shell level. Any avatar
 * or name across the platform can open it via `useTeamMemberPanel()`.
 */

import * as React from 'react';
import { TeamMemberPanel, type TeamMemberPanelTab } from '@/components/team-member-panel/panel';

interface OpenOptions {
  defaultTab?: TeamMemberPanelTab;
}

interface TeamMemberPanelContextValue {
  open: (userId: string, opts?: OpenOptions) => void;
  close: () => void;
  isOpen: boolean;
  userId: string | null;
}

const TeamMemberPanelContext = React.createContext<TeamMemberPanelContextValue | null>(null);

const EVENT_NAME = 'weldchat:open-user-profile';

export function TeamMemberPanelProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = React.useState<string | null>(null);
  const [isOpen, setIsOpen] = React.useState(false);
  const [defaultTab, setDefaultTab] = React.useState<TeamMemberPanelTab>('overview');

  const open = React.useCallback((nextUserId: string, opts?: OpenOptions) => {
    setUserId(nextUserId);
    setDefaultTab(opts?.defaultTab ?? 'overview');
    setIsOpen(true);
  }, []);

  const close = React.useCallback(() => setIsOpen(false), []);

  // Bridge the legacy WeldChat "openUserProfile" custom event so that
  // existing avatars continue to work unchanged.
  React.useEffect(() => {
    const handler = (e: Event) => {
      const target = (e as CustomEvent<{ userId?: string; defaultTab?: TeamMemberPanelTab }>).detail;
      if (!target?.userId) return;
      open(target.userId, { defaultTab: target.defaultTab });
    };
    window.addEventListener(EVENT_NAME, handler as EventListener);
    return () => window.removeEventListener(EVENT_NAME, handler as EventListener);
  }, [open]);

  const value = React.useMemo(
    () => ({ open, close, isOpen, userId }),
    [open, close, isOpen, userId],
  );

  return (
    <TeamMemberPanelContext.Provider value={value}>
      {children}
      <TeamMemberPanel
        userId={userId}
        open={isOpen}
        onOpenChange={(next) => setIsOpen(next)}
        defaultTab={defaultTab}
      />
    </TeamMemberPanelContext.Provider>
  );
}

export function useTeamMemberPanel(): TeamMemberPanelContextValue {
  const ctx = React.useContext(TeamMemberPanelContext);
  if (!ctx) {
    throw new Error('useTeamMemberPanel must be used within TeamMemberPanelProvider');
  }
  return ctx;
}

/**
 * Fires the legacy event that the provider bridges — handy for non-React code
 * or module boundaries where the hook can't be imported.
 */
export function openTeamMemberPanelEvent(userId: string, defaultTab?: TeamMemberPanelTab) {
  window.dispatchEvent(
    new CustomEvent(EVENT_NAME, { detail: { userId, defaultTab } }),
  );
}
