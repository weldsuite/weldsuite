import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useAppAccess } from '@/hooks/use-app-access';
import { useWeldChatUserEvents } from '@/hooks/weldchat/use-weldchat-realtime';
import { ChatLayoutClient } from './components/chat-layout-client';
import { PageLoader } from '@/components/page-loader';

// Eagerly preload the RealtimeKit SDK so it's ready when a call starts.
// This import runs once when the WeldChat layout module is loaded and
// warms the chunk in the browser cache, avoiding a lazy-load delay at call time.
import('@cloudflare/realtimekit').catch(() => {});

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('weldchat');
  useWeldChatUserEvents();

  // Request browser notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
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
