/** Who has opened an announcement and who has not, for the employees it is meant for. */

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrAnnouncement, HrAnnouncementRead } from '@weldsuite/app-api-client/domains/weldhr';
import { useHrAnnouncementReads } from '@/hooks/queries/use-weldhr-queries';
import { EmptyText } from '../../components/page-kit';
import { EmployeeAvatar, ErrorBanner, errorMessage, formatDateTime } from '../../components/shared';
import { TabLoading } from '../../me/components/shared';

function ReadList({ items, empty, showDate }: Readonly<{ items: HrAnnouncementRead[]; empty: string; showDate: boolean }>) {
  const t = useTranslations();
  if (items.length === 0) return <EmptyText>{empty}</EmptyText>;
  return (
    <ul className="divide-y rounded-md border">
      {items.map((item) => (
        <li key={item.employeeId} className="flex items-center gap-3 px-3 py-2 text-sm">
          <EmployeeAvatar name={item.employeeName} className="h-7 w-7" />
          <span className="min-w-0 flex-1 truncate">{item.employeeName}</span>
          {showDate && item.readAt && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {t('weldhr.announcements.reads.readAt', { date: formatDateTime(item.readAt) })}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function AnnouncementReadsSheet({ announcement, onClose }: Readonly<{ announcement: HrAnnouncement; onClose: () => void }>) {
  const t = useTranslations();
  const { data, isLoading, error } = useHrAnnouncementReads(announcement.id);
  const read = (data ?? []).filter((item) => item.readAt);
  const notRead = (data ?? []).filter((item) => !item.readAt);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="truncate">{announcement.title}</SheetTitle>
          <SheetDescription>
            {t('weldhr.announcements.reads.summary', { read: announcement.readCount, total: announcement.audienceCount })}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-6">
          {isLoading && <TabLoading />}
          {error && <ErrorBanner error={errorMessage(error, t('weldhr.announcements.reads.loadFailed'))} />}
          {data && (
            <Tabs defaultValue={notRead.length > 0 ? 'not-read' : 'read'}>
              <TabsList>
                <TabsTrigger value="not-read">{t('weldhr.announcements.reads.notReadTab', { count: notRead.length })}</TabsTrigger>
                <TabsTrigger value="read">{t('weldhr.announcements.reads.readTab', { count: read.length })}</TabsTrigger>
              </TabsList>
              <TabsContent value="not-read">
                <ReadList items={notRead} empty={t('weldhr.announcements.reads.emptyNotRead')} showDate={false} />
              </TabsContent>
              <TabsContent value="read">
                <ReadList items={read} empty={t('weldhr.announcements.reads.emptyRead')} showDate />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
