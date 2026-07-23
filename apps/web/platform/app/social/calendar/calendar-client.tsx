import { useState } from 'react';
import {
  format as formatDate,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  startOfWeek,
  endOfWeek,
  isSameDay,
  isSameMonth,
  addMonths,
  subMonths,
} from 'date-fns';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  useSocialPosts,
  useRescheduleSocialPost,
} from '@/hooks/queries/use-social-queries';
import { ComposerDialog } from '@/app/social/components/composer-dialog';

export function CalendarClient() {
  const { t } = useI18n();
  const st = useTranslations();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [composeOpen, setComposeOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  const { data, isLoading } = useSocialPosts({ status: 'scheduled' });
  const reschedulePost = useRescheduleSocialPost();

  const posts = data?.data || [];

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const calStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: calStart, end: calEnd });

  const getPostsForDay = (day: Date) =>
    posts.filter(
      (p: any) => p.scheduledAt && isSameDay(new Date(p.scheduledAt), day)
    );

  const selectedDayPosts = selectedDay ? getPostsForDay(selectedDay) : [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t.social.calendar.contentCalendar}</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium w-32 text-center">
            {formatDate(currentMonth, 'MMMM yyyy')}
          </span>
          <Button variant="outline" size="sm" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={() => setComposeOpen(true)}>
            {t.social.posts.newPost}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Day headers */}
          <div className="grid grid-cols-7 gap-px">
            {st('sweep.miscA.socialCalendar.dayLabels').split(',').map((d) => (
              <div key={d} className="text-center text-xs font-medium text-muted-foreground py-2">
                {d}
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div className="grid grid-cols-7 gap-px border rounded-lg overflow-hidden bg-border">
            {days.map((day) => {
              const dayPosts = getPostsForDay(day);
              const isCurrentMonth = isSameMonth(day, currentMonth);
              const isSelected = selectedDay && isSameDay(day, selectedDay);
              return (
                <button
                  key={day.toISOString()}
                  onClick={() => setSelectedDay(isSameDay(day, selectedDay ?? new Date(0)) ? null : day)}
                  className={`bg-background min-h-[80px] p-1.5 text-left hover:bg-accent/50 transition-colors ${
                    isSelected ? 'ring-2 ring-inset ring-primary' : ''
                  }`}
                >
                  <span
                    className={`text-xs font-medium ${
                      isCurrentMonth ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {formatDate(day, 'd')}
                  </span>
                  <div className="mt-1 space-y-0.5">
                    {dayPosts.slice(0, 3).map((post: any) => (
                      <div
                        key={post.id}
                        className="text-xs bg-primary/10 text-primary rounded px-1 py-0.5 truncate"
                      >
                        {post.content?.slice(0, 20) || st('sweep.miscA.socialCalendar.post')}
                      </div>
                    ))}
                    {dayPosts.length > 3 && (
                      <div className="text-xs text-muted-foreground">{st('sweep.miscA.socialCalendar.moreCount', { count: dayPosts.length - 3 })}</div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Selected day posts */}
          {selectedDay && (
            <div className="border rounded-lg p-4 space-y-3">
              <h3 className="text-sm font-semibold">
                {formatDate(selectedDay, 'PPP')} — {st('sweep.miscA.socialCalendar.postsCount', { count: selectedDayPosts.length })}
              </h3>
              {selectedDayPosts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t.social.calendar.noScheduledPosts}</p>
              ) : (
                selectedDayPosts.map((post: any) => (
                  <div key={post.id} className="flex items-start justify-between gap-3 py-2 border-b last:border-0">
                    <p className="text-sm line-clamp-2 flex-1">{post.content || '—'}</p>
                    <div className="flex items-center gap-2 shrink-0">
                      {post.scheduledAt && (
                        <span className="text-xs text-muted-foreground">
                          {formatDate(new Date(post.scheduledAt), 'h:mm a')}
                        </span>
                      )}
                      <Badge variant="outline" className="text-xs">{post.status}</Badge>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}

      <ComposerDialog open={composeOpen} onOpenChange={setComposeOpen} />
    </div>
  );
}
