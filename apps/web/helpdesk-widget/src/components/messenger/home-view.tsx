import { ChevronRight, Send, X } from 'lucide-react';
import type { WidgetConfigResponse } from '@/lib/api/types';
import type { Messenger } from '@/hooks/use-messenger';
import { Avatar, AvatarStack, readableOn, timeAgo } from './parts';

interface HomeViewProps {
  config: WidgetConfigResponse;
  messenger: Messenger;
  onNewConversation: () => void;
  onOpenConversation: (id: string) => void;
  onClose?: () => void;
}

export function HomeView({ config, messenger, onNewConversation, onOpenConversation, onClose }: HomeViewProps) {
  const color = config.branding.primaryColor;
  const onColor = readableOn(color);
  const recent = messenger.conversations.find((c) => c.state === 'open') ?? null;
  const firstName = messenger.profile.name.split(/\s+/)[0];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" data-testid="home-view">
      <div
        className="px-6 pt-6 pb-16"
        style={{ background: `linear-gradient(160deg, ${color} 0%, ${color}e6 60%, ${color}b3 100%)`, color: onColor }}
      >
        <div className="flex items-start justify-between">
          <AvatarStack team={config.team} size={34} ring={color} />
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              data-testid="close-button"
              className="rounded-full p-1.5 opacity-80 hover:opacity-100 hover:bg-white/15 transition"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
        <h1 className="mt-8 text-[26px] font-semibold leading-tight tracking-tight opacity-80">
          Hi{firstName ? ` ${firstName}` : ' there'} 👋
        </h1>
        <p className="mt-1 text-[26px] font-semibold leading-tight tracking-tight text-balance">{config.greeting}</p>
      </div>

      <div className="-mt-10 px-4 pb-4 space-y-3">
        {recent && (
          <button
            type="button"
            onClick={() => onOpenConversation(recent.id)}
            className="w-full text-left rounded-2xl bg-white p-4 shadow-[0_2px_12px_rgba(0,0,0,0.08)] border border-gray-100 hover:shadow-[0_4px_18px_rgba(0,0,0,0.12)] transition"
          >
            <p className="text-[13px] font-semibold text-gray-900 mb-2">Recent message</p>
            <div className="flex items-center gap-3">
              <Avatar
                name={recent.assignee?.name ?? config.team[0]?.name ?? 'Support'}
                src={recent.assignee?.avatar ?? config.team[0]?.avatar}
                size={36}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-900 truncate">{recent.lastMessagePreview || recent.title || 'Conversation'}</p>
                <p className="text-xs text-gray-500">
                  {recent.lastMessageFromTeam ? recent.assignee?.name ?? 'Support' : 'You'} · {timeAgo(recent.lastMessageAt)}
                </p>
              </div>
              {messenger.isUnread(recent) ? (
                <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              ) : (
                <ChevronRight className="h-4 w-4 text-gray-400 flex-shrink-0" />
              )}
            </div>
          </button>
        )}

        <button
          type="button"
          onClick={onNewConversation}
          data-testid="new-conversation"
          className="group w-full text-left rounded-2xl bg-white p-4 shadow-[0_2px_12px_rgba(0,0,0,0.08)] border border-gray-100 hover:shadow-[0_4px_18px_rgba(0,0,0,0.12)] transition flex items-center gap-3"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900">Send us a message</p>
            <p className="text-xs text-gray-500 mt-0.5">We&apos;ll get back to you as soon as we can</p>
          </div>
          <Send className="h-4 w-4 flex-shrink-0 transition-transform group-hover:translate-x-0.5" style={{ color }} />
        </button>
      </div>
    </div>
  );
}
