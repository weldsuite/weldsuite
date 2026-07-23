// TODO(cleanup): replace legacy inbox route — see .claude/welddesk-intercom-plan.md
// §6 Phase 2. This is the new Intercom-model inbox shell living at
// /welddesk/inbox2 to avoid colliding with the legacy /welddesk/inbox routes
// during the transition. Flip the route (and delete the legacy pages) once
// stage 2 (conversation pane) + parity checks land.

import { useAppAccess } from '@/hooks/use-app-access';
import { getTranslations } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';
import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { InboxSidebar } from './inbox-sidebar';

/**
 * Three-pane inbox shell: sidebar (240px) | conversation list (340px, from
 * the routed child) | conversation pane (flex, from the routed child).
 *
 * The list + pane are NOT rendered here — they're the route's own children
 * (index.tsx renders list + empty-state pane; $conversationId.tsx renders
 * list + <ConversationPane>). This component only owns the sidebar + the
 * app-access/permission gate, mirroring app/weldknow/layout.tsx.
 */
export function InboxLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const tInbox = getTranslations('deskInbox2');
  const { isInstalled, isLoading } = useAppAccess('welddesk');
  const canRead = useCan('welddesk:conversations:read');

  if (isLoading) return <PageLoader />;

  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t.common.empty.appNotInstalled}
      </div>
    );
  }

  if (!canRead) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {tInbox.list.loadError}
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <aside className="w-[240px] shrink-0 border-r flex flex-col h-full hidden md:flex">
        <InboxSidebar />
      </aside>
      <div className="flex-1 min-w-0 flex overflow-hidden">{children}</div>
    </div>
  );
}
