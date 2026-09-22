import { useCallback, useEffect, useState } from 'react';
import { Home, MessageCircle } from 'lucide-react';
import type { WidgetConfigResponse } from '@/lib/api/types';
import { DRAFT_ID, useMessenger } from '@/hooks/use-messenger';
import { cn } from '@/lib/utils/cn';
import { HomeView } from './home-view';
import { MessagesView } from './messages-view';
import { ConversationView } from './conversation-view';
import { Branding } from './parts';

type View =
  | { name: 'home' | 'messages' }
  | { name: 'conversation'; id: string; from: 'home' | 'messages' };

interface MessengerProps {
  config: WidgetConfigResponse;
  /** Panel is visible (SDK told us it's open, or standalone and expanded). */
  isOpen: boolean;
  onClose?: () => void;
  onUnreadChange?: (count: number) => void;
  initialName?: string;
  initialEmail?: string;
  realtimeUrl: string | null;
}

export function Messenger({
  config,
  isOpen,
  onClose,
  onUnreadChange,
  initialName,
  initialEmail,
  realtimeUrl,
}: MessengerProps) {
  const [view, setView] = useState<View>({ name: 'home' });
  const activeId = view.name === 'conversation' ? view.id : null;

  const messenger = useMessenger({
    widgetId: config.widgetId,
    realtimeUrl,
    isOpen,
    activeId,
    initialName,
    initialEmail,
  });

  useEffect(() => {
    onUnreadChange?.(messenger.unreadCount);
  }, [messenger.unreadCount, onUnreadChange]);

  const from = view.name === 'messages' ? 'messages' : 'home';
  const openConversation = useCallback(
    (id: string) => setView({ name: 'conversation', id, from }),
    [from],
  );
  const newConversation = useCallback(() => setView({ name: 'conversation', id: DRAFT_ID, from }), [from]);
  const back = useCallback(() => {
    setView((current) => (current.name === 'conversation' ? { name: current.from } : { name: 'home' }));
    void messenger.refreshConversations();
  }, [messenger]);

  const color = config.branding.primaryColor;
  const showNav = view.name !== 'conversation';

  return (
    <div className="helpdesk-widget flex h-full w-full flex-col overflow-hidden bg-white" data-testid="widget-container">
      {view.name === 'home' && (
        <HomeView
          config={config}
          messenger={messenger}
          onNewConversation={newConversation}
          onOpenConversation={openConversation}
          onClose={onClose}
        />
      )}
      {view.name === 'messages' && (
        <MessagesView
          config={config}
          messenger={messenger}
          onNewConversation={newConversation}
          onOpenConversation={openConversation}
          onClose={onClose}
        />
      )}
      {view.name === 'conversation' && (
        <ConversationView
          config={config}
          messenger={messenger}
          conversationId={view.id}
          onCreated={(id) => setView((current) => ({ name: 'conversation', id, from: current.name === 'conversation' ? current.from : 'home' }))}
          onBack={back}
          onClose={onClose}
          isOpen={isOpen}
        />
      )}

      {showNav && (
        <nav className="grid grid-cols-2 border-t border-gray-100 flex-shrink-0">
          {([
            { name: 'home' as const, label: 'Home', Icon: Home },
            { name: 'messages' as const, label: 'Messages', Icon: MessageCircle },
          ]).map(({ name, label, Icon }) => {
            const active = view.name === name;
            return (
              <button
                key={name}
                type="button"
                onClick={() => setView({ name })}
                data-testid={`nav-${name}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium transition',
                  active ? '' : 'text-gray-500 hover:text-gray-700',
                )}
                style={active ? { color } : undefined}
              >
                <span className="relative">
                  <Icon className="h-5 w-5" />
                  {name === 'messages' && messenger.unreadCount > 0 && (
                    <span className="absolute -right-2 -top-1.5 min-w-[16px] h-4 rounded-full bg-red-500 px-1 text-[10px] font-bold leading-4 text-white">
                      {messenger.unreadCount}
                    </span>
                  )}
                </span>
                {label}
              </button>
            );
          })}
        </nav>
      )}

      {config.showBranding && <Branding />}
    </div>
  );
}
