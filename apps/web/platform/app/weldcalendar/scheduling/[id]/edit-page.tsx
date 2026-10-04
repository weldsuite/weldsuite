
import { useParams } from '@/lib/router';
import { useBookingPage } from '@/hooks/queries/use-calendar-queries';
import { BookingPageEditor } from '../new/page';
import { getTranslations } from '@/lib/i18n';
import { DEFAULT_MAX_ADVANCE_DAYS, DEFAULT_MIN_NOTICE_MINUTES } from '../../lib/booking-editor-settings';

export default function BookingPageEditPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useBookingPage(id);
  const bookingPage = data?.data;
  const t = getTranslations('weldcalendar');

  if (isLoading) return <div className="flex items-center justify-center py-12 text-muted-foreground">{t.bookingDetail.loadingBookingPage}</div>;
  if (!bookingPage) return <div className="flex items-center justify-center py-12 text-muted-foreground">{t.bookingDetail.bookingPageNotFound}</div>;

  return (
    <BookingPageEditor
      mode="edit"
      bookingPageId={id}
      initialData={{
        title: bookingPage.name || '',
        duration: bookingPage.duration || 120,
        availability: bookingPage.availability,
        bufferBefore: bookingPage.bufferBefore || 0,
        bufferAfter: bookingPage.bufferAfter || 0,
        minNotice: bookingPage.minNotice ?? DEFAULT_MIN_NOTICE_MINUTES,
        maxAdvance: bookingPage.maxAdvance ?? DEFAULT_MAX_ADVANCE_DAYS,
        dateOverrides: bookingPage.dateOverrides ?? [],
        maxBookingsPerDay: bookingPage.maxBookingsPerDay ?? null,
      }}
    />
  );
}
