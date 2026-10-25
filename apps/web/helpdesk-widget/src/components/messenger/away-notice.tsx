import { Moon } from 'lucide-react';
import type { WidgetConfigResponse } from '@/lib/api/types';
import { backAtText, t } from '@/lib/i18n';

/** "Usually replies …" for the team's chosen reply time, or null when none is set. */
export function replyTimeText(config: WidgetConfigResponse): string | null {
  return config.expectedReplyTime ? t.replyTime[config.expectedReplyTime] : null;
}

/** Second line under the away title: when they're back, then how soon they reply. */
export function awayDetail(config: WidgetConfigResponse, nextOpenAt: string | null): string {
  return [nextOpenAt ? backAtText(nextOpenAt) : null, replyTimeText(config)].filter(Boolean).join(' · ');
}

/** Outside office hours: the team's away message, when they're back and how soon they reply. */
export function AwayNotice({
  config,
  nextOpenAt,
  className,
}: Readonly<{ config: WidgetConfigResponse; nextOpenAt: string | null; className?: string }>) {
  const detail = awayDetail(config, nextOpenAt);
  return (
    <div className={className} data-testid="away-notice">
      <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-3.5">
        <Moon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-gray-900">{t.away.title}</p>
          <p className="mt-0.5 text-xs text-gray-700 whitespace-pre-wrap break-words">
            {config.awayMessage || t.away.message}
          </p>
          {detail && <p className="mt-1 text-xs text-gray-500">{detail}</p>}
        </div>
      </div>
    </div>
  );
}
