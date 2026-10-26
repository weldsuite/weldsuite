/**
 * My HR → Announcements: what the HR team posted for you, pinned first. Opening
 * one marks it as read; one you have not opened yet carries a dot (and the
 * sidebar item a count).
 */

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, Megaphone, Pin } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfAnnouncement } from '@weldsuite/app-api-client/domains/weldhr';
import { useMyHrAnnouncements, useMyHrMarkAnnouncementRead } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { emptyIcon } from '../../components/page-kit';
import { ErrorBanner, errorMessage, formatDate } from '../../components/shared';
import { TabLoading } from './shared';

export function MyAnnouncementsTab({ openId }: Readonly<{ openId?: string }>) {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrAnnouncements();
  const markRead = useMyHrMarkAnnouncementRead();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Announcements already sent to the server as read, so a refetch in flight does not send them twice.
  const requestedRead = useRef(new Set<string>());
  const openedFromLink = useRef<string | null>(null);

  function markAsRead(announcement: HrSelfAnnouncement) {
    if (announcement.readAt || requestedRead.current.has(announcement.id)) return;
    requestedRead.current.add(announcement.id);
    markRead.mutate(announcement.id, {
      onError: (err) => {
        requestedRead.current.delete(announcement.id);
        toast.error(errorMessage(err, t('weldhr.me.announcements.markReadFailed')));
      },
    });
  }

  function toggle(announcement: HrSelfAnnouncement) {
    const opening = !expanded.has(announcement.id);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (opening) next.add(announcement.id);
      else next.delete(announcement.id);
      return next;
    });
    if (opening) markAsRead(announcement);
  }

  // A link from a push notification: open that announcement once the list is there.
  const linked = openId ? data?.announcements.find((a) => a.id === openId) : undefined;
  useEffect(() => {
    if (!linked || openedFromLink.current === linked.id) return;
    openedFromLink.current = linked.id;
    setExpanded((previous) => new Set(previous).add(linked.id));
    if (!linked.readAt && !requestedRead.current.has(linked.id)) {
      requestedRead.current.add(linked.id);
      markRead.mutate(linked.id, {
        onError: (err) => {
          requestedRead.current.delete(linked.id);
          toast.error(errorMessage(err, t('weldhr.me.announcements.markReadFailed')));
        },
      });
    }
    document.getElementById(`my-hr-announcement-${linked.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [linked, markRead, t]);

  if (isLoading) return <TabLoading />;
  if (!data) return <ErrorBanner error={errorMessage(error, t('weldhr.me.announcements.loadFailed'))} />;

  if (data.announcements.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
        {emptyIcon(Megaphone)}
        <h2 className="mb-1.5 text-[15px] font-semibold">{t('weldhr.me.announcements.empty.title')}</h2>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{t('weldhr.me.announcements.empty.description')}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {data.announcements.map((announcement) => {
        const open = expanded.has(announcement.id);
        const unread = !announcement.readAt;
        return (
          <Card key={announcement.id} id={`my-hr-announcement-${announcement.id}`} className="scroll-mt-4">
            <CardContent className="p-0">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(announcement)}
                className="flex w-full items-start gap-3 rounded-xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', unread ? 'bg-primary' : 'bg-transparent')}
                  role={unread ? 'img' : undefined}
                  aria-label={unread ? t('weldhr.me.announcements.new') : undefined}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className={cn('text-sm', unread ? 'font-semibold' : 'font-medium')}>{announcement.title}</h2>
                    {announcement.pinned && (
                      <Badge variant="outline" className="gap-1">
                        <Pin className="h-3 w-3" />
                        {t('weldhr.me.announcements.pinned')}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {[announcement.createdByName ? t('weldhr.me.announcements.postedBy', { name: announcement.createdByName }) : null, formatDate(announcement.publishedAt)]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {/* Plain text from HR: keep its line breaks, never render it as markup. */}
                  <p className={cn('whitespace-pre-wrap break-words text-sm text-muted-foreground', !open && 'line-clamp-2')}>{announcement.body}</p>
                </div>
                <ChevronDown className={cn('mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
              </button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
