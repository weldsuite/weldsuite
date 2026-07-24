
import { useNavigate } from '@tanstack/react-router';
import { CalendarDays, Plus } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { useBookingPages } from '@/hooks/queries/use-calendar-queries';

export default function SchedulingPage() {
  const t = getTranslations('weldcalendar');
  const navigate = useNavigate();
  const { data, isLoading } = useBookingPages();

  const bookingPages = data?.data ?? [];

  const handleNewBookingPage = () => {
    navigate({ to: '/weldcalendar/scheduling/new' });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b px-4 py-2.5 bg-background shrink-0">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-muted-foreground" />
          <span className="text-base font-semibold">{t.scheduling.title}</span>
        </div>
        <Button size="sm" onClick={handleNewBookingPage}>
          <Plus className="h-4 w-4 mr-1" />
          {t.scheduling.newBookingPage}
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            {t.scheduling.loadingBookingPages}
          </div>
        ) : bookingPages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <CalendarDays className="h-12 w-12 text-muted-foreground/40" />
            <div className="space-y-1">
              <p className="text-base font-medium">{t.scheduling.noBookingPagesTitle}</p>
              <p className="text-sm text-muted-foreground">{t.scheduling.noBookingPagesSubtitle}</p>
            </div>
            <Button onClick={handleNewBookingPage}>
              <Plus className="h-4 w-4 mr-1" />
              {t.scheduling.newBookingPage}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 max-w-2xl">
            {bookingPages.filter((bp) => !!bp.id).map((bp) => (
              <div
                key={bp.id}
                className="flex items-center justify-between rounded-lg border p-4 hover:bg-accent/50 transition-colors cursor-pointer"
                onClick={() => navigate({ to: '/weldcalendar/scheduling/$id/view', params: { id: bp.id as string } })}
              >
                <div className="flex items-center gap-3">
                  <CalendarDays className="h-5 w-5 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-sm font-medium">{bp.name}</p>
                    {bp.duration && (
                      <p className="text-xs text-muted-foreground">{bp.duration} min</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
