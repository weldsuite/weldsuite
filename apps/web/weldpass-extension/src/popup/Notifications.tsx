/**
 * The bell's page: the person's latest notifications from their WeldSuite
 * server, in the platform's row-list style. A click marks one read and opens
 * it, but only on the person's own server: a notification's link is data from
 * the server, and the popup opens nothing else.
 */

import type { NotificationRow } from '@weldsuite/app-api-client/domains/notifications';
import { Bell } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { openTab } from '../lib/chrome-page';
import { t, textLanguage } from '../lib/i18n';
import type { AsyncState } from './hooks';
import { Empty, LoadError, Padded } from './list';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import type { PageResponses } from '../lib/protocol';

type NotificationsData = PageResponses['notifications:list'];

/** The notification's link, when it is on the person's own server. */
export function notificationHref(row: NotificationRow, serverOrigin: string): string | null {
  if (!row.actionUrl) return null;
  try {
    const url = new URL(row.actionUrl, serverOrigin);
    return url.origin === new URL(serverOrigin).origin ? url.href : null;
  } catch {
    return null;
  }
}

/** "5 min ago", in the popup's language. */
function ago(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 60) return t('justNow');
  const language = textLanguage();
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['minute', 60],
    ['hour', 60],
    ['day', 24],
    ['week', 7],
  ];
  let value = seconds / 60;
  let unit: Intl.RelativeTimeFormatUnit = 'minute';
  for (let index = 1; index < steps.length && value >= steps[index]![1]; index += 1) {
    value /= steps[index]![1];
    unit = steps[index]![0];
  }
  return format.format(-Math.floor(value), unit);
}

export function NotificationsView({
  notifications,
  serverOrigin,
  onRead,
}: Readonly<{
  notifications: AsyncState<NotificationsData>;
  serverOrigin: string;
  onRead: (row: NotificationRow) => void;
}>) {
  if (notifications.loading && !notifications.data) {
    return (
      <Padded>
        <InlineSpinner label={t('loading')} className="py-0" />
      </Padded>
    );
  }
  if (notifications.error || !notifications.data) {
    return <LoadError error={notifications.error} onRetry={notifications.reload} />;
  }

  const { items } = notifications.data;
  return (
    <>
      {items.length === 0 ? (
        <Empty>{t('notificationsEmpty')}</Empty>
      ) : (
        <ul>
          {items.map((row) => {
            const href = notificationHref(row, serverOrigin);
            const unreadRow = !row.isRead;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (unreadRow) onRead(row);
                    if (href) openTab(href);
                  }}
                  className="flex w-full items-start gap-2.5 border-b border-border/70 px-3 py-2 text-left transition-colors hover:bg-muted/40"
                >
                  <span aria-hidden className="relative flex size-8 shrink-0 items-center justify-center rounded-[10px] border bg-card">
                    <Bell className="size-4 text-muted-foreground" />
                    {unreadRow && (
                      <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-background bg-primary" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={cn('min-w-0 flex-1 truncate', unreadRow ? 'font-semibold' : 'font-medium')}>
                        {row.title ?? row.notificationType}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{ago(row.createdAt)}</span>
                    </span>
                    {row.body && <span className="line-clamp-2 text-xs text-muted-foreground">{row.body}</span>}
                    {unreadRow && <span className="sr-only">{t('notificationsNew')}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
