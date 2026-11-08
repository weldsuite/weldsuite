import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle, type LucideIcon } from 'lucide-react';
import type { DeskPublicAnnouncement } from '@weldsuite/app-api-client/schemas/desk-knowledge';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils/cn';
import { dismiss, loadDismissed } from '@/lib/utils/dismissed-storage';
import { LinkifiedText } from './linkified-text';

const TONES: Record<string, { box: string; icon: string; Icon: LucideIcon }> = {
  info: { box: 'border-sky-200 bg-sky-50', icon: 'text-sky-600', Icon: Info },
  warning: { box: 'border-amber-200 bg-amber-50', icon: 'text-amber-600', Icon: AlertTriangle },
  success: { box: 'border-emerald-200 bg-emerald-50', icon: 'text-emerald-600', Icon: CheckCircle2 },
  error: { box: 'border-red-200 bg-red-50', icon: 'text-red-600', Icon: XCircle },
};

/**
 * The team's announcements (status banners) at the top of the home view, in
 * the order the API sends them (pinned first), coloured by type. Each can be
 * closed; this browser then leaves it closed.
 */
export function Announcements({
  widgetId,
  announcements,
  className,
}: Readonly<{ widgetId: string; announcements: DeskPublicAnnouncement[]; className?: string }>) {
  const [dismissed, setDismissed] = useState<string[]>(() => loadDismissed(widgetId));
  const shown = announcements.filter((a) => !dismissed.includes(a.id));
  if (shown.length === 0) return null;

  return (
    <div className={cn('space-y-2', className)} data-testid="announcements">
      {shown.map((announcement) => {
        const tone = TONES[announcement.type] ?? TONES.info;
        const text = announcement.content.trim() || announcement.excerpt?.trim() || '';
        return (
          <div
            key={announcement.id}
            role={announcement.type === 'error' || announcement.type === 'warning' ? 'alert' : 'status'}
            className={cn(
              'flex gap-3 rounded-2xl border p-3.5 shadow-[0_2px_12px_rgba(0,0,0,0.08)]',
              tone.box,
            )}
          >
            <tone.Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', tone.icon)} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-gray-900">{announcement.title}</p>
              {text && (
                <p className="mt-0.5 text-xs text-gray-700 whitespace-pre-wrap break-words">
                  <LinkifiedText text={text} />
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setDismissed(dismiss(widgetId, announcement.id))}
              aria-label={t.selfService.dismiss}
              title={t.selfService.dismiss}
              className="-m-1 h-6 w-6 flex-shrink-0 rounded-full p-1 text-gray-500 transition hover:bg-black/5 hover:text-gray-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
