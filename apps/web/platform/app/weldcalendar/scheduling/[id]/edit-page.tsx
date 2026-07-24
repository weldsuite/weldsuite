
import { useParams } from '@/lib/router';
import { useBookingPage } from '@/hooks/queries/use-calendar-queries';
import { BookingPageEditor } from '../new/page';
import { getTranslations } from '@/lib/i18n';

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
      }}
    />
  );
}
