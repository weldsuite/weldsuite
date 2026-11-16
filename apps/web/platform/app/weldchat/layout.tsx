import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useAppAccess } from '@/hooks/use-app-access';
import { useWeldChatUserEvents } from '@/hooks/weldchat/use-weldchat-realtime';
import { ChatLayoutClient } from './components/chat-layout-client';
import { useRememberWeldChatPage } from './hooks/use-last-weldchat-page';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ensureNotificationPermission } from '@/lib/desktop-notifications';
import { prefetchCallSdk } from './lib/prefetch-call-sdk';

// Eagerly preload the call SDK (LiveKit's or RealtimeKit's) so it's ready when
// a call starts: this runs once when the WeldChat layout module is loaded.
void prefetchCallSdk();

export default function ChatLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('weldchat');
  useWeldChatUserEvents();
  useRememberWeldChatPage(isInstalled);

  // Request browser notification permission (no-op in the desktop shell).
  useEffect(() => {
    void ensureNotificationPermission();
  }, []);
  if (isLoading) return <PageLoader />;
  if (!isInstalled)
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t.common.empty.appNotInstalled}
      </div>
    );
  return (
    <ChatLayoutClient>{children}</ChatLayoutClient>
  );
}
