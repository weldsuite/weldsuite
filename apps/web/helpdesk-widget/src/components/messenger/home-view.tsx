import { ChevronRight, X } from 'lucide-react';
import type { WidgetConfigResponse } from '@/lib/api/types';
import type { Messenger } from '@/hooks/use-messenger';
import { useAvailability } from '@/hooks/use-availability';
import { useAnnouncements } from '@/hooks/use-self-service';
import { Avatar, AvatarStack, SendArrowIcon, timeAgo } from './parts';
import { AwayNotice } from './away-notice';
import { EmailCapture } from './email-capture';
import { Announcements } from './announcements';

/*
 * The Home header's backdrop: a dark, hazy sky in warm near-black that fades
 * into white behind the first card. Three layers, bottom to top:
 *  1. BACKDROP: the base (reddish near-black on the left, black on the right)
 *     with faint glows: a warm band beside the greeting, a soft lift across
 *     the middle, and a light patch low on the left where the fade begins.
 *  2. HAZE: a grey haze over the right of the header, fading in from the left
 *     (HAZE) and from the top (HAZE_MASK).
 *  3. FADE: white over the header's last 83px, over a soft lift at the top of
 *     the haze and light patches low on the right edge.
 * The text sits 83px above the header's bottom; the glows near it are placed
 * from the bottom so they stay put against the greeting, the haze from the top.
 */
const BACKDROP_BASE = 'rgb(14, 12, 11)';

const BACKDROP = [
  'radial-gradient(95px 58px at 0% calc(100% - 34px), rgba(124, 116, 111, 0.7) 0%, rgba(124, 116, 111, 0.6) 60%, rgba(124, 116, 111, 0) 100%)',
  'radial-gradient(130px 20px at 0% calc(100% - 138px), rgba(70, 52, 48, 0.9), rgba(70, 52, 48, 0))',
  'radial-gradient(170px 40px at 45% calc(100% - 147px), rgba(62, 57, 54, 0.25), rgba(62, 57, 54, 0))',
  'linear-gradient(90deg, rgb(33, 22, 21) 0%, rgb(22, 17, 16) 18%, rgb(10, 9, 9) 42%, rgb(5, 5, 5) 62%, rgb(4, 4, 4) 100%)',
].join(', ');

const HAZE_RGB = '95, 94, 87';
const HAZE = `linear-gradient(to left, rgb(${HAZE_RGB}) 48px, rgba(${HAZE_RGB}, 0.97) 58px, rgba(${HAZE_RGB}, 0.85) 78px, rgba(${HAZE_RGB}, 0.62) 98px, rgba(${HAZE_RGB}, 0.42) 118px, rgba(${HAZE_RGB}, 0.22) 138px, rgba(${HAZE_RGB}, 0.05) 158px, rgba(${HAZE_RGB}, 0) 190px)`;
const HAZE_MASK =
  'linear-gradient(to bottom, transparent 50px, rgba(0, 0, 0, 0.06) 65px, rgba(0, 0, 0, 0.13) 80px, rgba(0, 0, 0, 0.17) 95px, rgba(0, 0, 0, 0.26) 105px, rgba(0, 0, 0, 0.46) 115px, rgba(0, 0, 0, 0.54) 125px, rgba(0, 0, 0, 0.63) 135px, rgba(0, 0, 0, 0.88) 145px, rgba(0, 0, 0, 0.92) 155px, #000 170px)';

const FADE = [
  'linear-gradient(to bottom, rgba(255, 255, 255, 0) calc(100% - 83px), #ffffff 100%)',
  'radial-gradient(70px 37px at 100% calc(100% - 31px), rgba(232, 232, 226, 1), rgba(232, 232, 226, 0))',
  'radial-gradient(50px 42px at 100% calc(100% - 64px), rgba(175, 174, 170, 0.8), rgba(175, 174, 170, 0))',
  `radial-gradient(90px 26px at 78% 122px, rgba(${HAZE_RGB}, 0.3), rgba(${HAZE_RGB}, 0))`,
].join(', ');

interface HomeViewProps {
  config: WidgetConfigResponse;
  messenger: Messenger;
  onNewConversation: () => void;
  onOpenConversation: (id: string) => void;
  onClose?: () => void;
}

export function HomeView({ config, messenger, onNewConversation, onOpenConversation, onClose }: Readonly<HomeViewProps>) {
  const color = config.branding.primaryColor;
  const recent = messenger.conversations.find((c) => c.state === 'open') ?? null;
  const firstName = messenger.profile.name.split(/\s+/)[0];
  const { away, nextOpenAt } = useAvailability(config);
  const announcements = useAnnouncements(config.widgetId, messenger.visitorId);

  return (
    <div className="widget-scrollbar flex-1 min-h-0 overflow-y-auto" data-testid="home-view">
      <div className="relative pl-10 pr-[21px] pt-8 pb-[83px] text-white" style={{ background: BACKDROP }}>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ background: HAZE, maskImage: HAZE_MASK, WebkitMaskImage: HAZE_MASK }}
        />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: FADE }} />
        <div className="relative flex items-start justify-between">
          <AvatarStack team={config.team} size={40} ring={BACKDROP_BASE} overlap={2} />
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              data-testid="close-button"
              className="mt-px rounded-xl p-2 text-white/90 hover:bg-white/15 hover:text-white transition"
            >
              <X className="h-[18px] w-[18px]" />
            </button>
          )}
        </div>
        <div className="relative pr-[19px]">
          <h1 className="mt-[71px] text-[28px] font-bold leading-[1.2] tracking-[-0.015em] text-white/65">
            Hi{firstName ? ` ${firstName}` : ' there'} 👋
          </h1>
          <p className="text-[28px] font-bold leading-[1.2] tracking-[-0.015em]">{config.greeting}</p>
        </div>
      </div>

      <div className="relative -mt-[57px] px-5 pb-4 space-y-3">
        <Announcements widgetId={config.widgetId} announcements={announcements} />
        {away && (
          <AwayNotice
            config={config}
            nextOpenAt={nextOpenAt}
            className="rounded-2xl bg-white shadow-[0_2px_12px_rgba(0,0,0,0.08)]"
          />
        )}
        {away && !messenger.profile.email && <EmailCapture messenger={messenger} color={color} away className="m-0" />}

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
          className="w-full flex items-center justify-between gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4 text-left text-sm font-semibold leading-5 text-gray-900 transition-colors hover:bg-gray-50"
        >
          <span className="min-w-0 truncate">Send us a message</span>
          <SendArrowIcon style={{ color }} />
        </button>
      </div>
    </div>
  );
}
