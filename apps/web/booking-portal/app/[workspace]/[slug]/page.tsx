import { eq, and, isNull } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { calendarBookingPages, calendarBookings } from '@weldsuite/db/schema';

import { getTenantDbBySlug } from '@/lib/db';
import { bookingPagePropsSchema } from '@/lib/schemas';
import { sanitizeAvailability } from '@/lib/availability';
import { getHostInfo, isValidManageToken } from '@/lib/booking-server';

import { BookingClient, type ManagedBooking } from './booking-client';

type Props = {
  params: Promise<{ workspace: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export async function generateMetadata({ params }: Props) {
  const { workspace, slug } = await params;

  const tenant = await getTenantDbBySlug(workspace);
  if (!tenant) return { title: 'Not Found' };
  const [page] = await tenant.db
    .select({ name: calendarBookingPages.name, description: calendarBookingPages.description })
    .from(calendarBookingPages)
    .where(
      and(
        eq(calendarBookingPages.slug, slug),
        eq(calendarBookingPages.isActive, true),
        isNull(calendarBookingPages.deletedAt),
      ),
    )
    .limit(1);

  if (!page) return { title: 'Not Found' };

  return {
    title: `${page.name} — ${tenant.workspace.name}`,
    description: page.description || `Book a meeting: ${page.name}`,
  };
}

export default async function BookingPage({ params, searchParams }: Readonly<Props>) {
  const { workspace: workspaceSlug, slug } = await params;
  const query = await searchParams;

  const tenant = await getTenantDbBySlug(workspaceSlug);
  if (!tenant) notFound();

  const [bookingPage] = await tenant.db
    .select()
    .from(calendarBookingPages)
    .where(
      and(
        eq(calendarBookingPages.slug, slug),
        eq(calendarBookingPages.isActive, true),
        isNull(calendarBookingPages.deletedAt),
      ),
    )
    .limit(1);

  if (!bookingPage) notFound();

  const parseResult = bookingPagePropsSchema.safeParse({
    id: bookingPage.id,
    name: bookingPage.name,
    slug: bookingPage.slug,
    description: bookingPage.description,
    duration: bookingPage.duration,
    bufferBefore: bookingPage.bufferBefore,
    bufferAfter: bookingPage.bufferAfter,
    color: bookingPage.color,
    locationType: bookingPage.locationType,
    locationValue: bookingPage.locationValue,
    availability: sanitizeAvailability(bookingPage.availability),
    questions: bookingPage.questions ?? [],
    minNotice: bookingPage.minNotice,
    maxAdvance: bookingPage.maxAdvance,
    confirmationMessage: bookingPage.confirmationMessage,
    timezone: bookingPage.timezone || 'UTC',
  });

  if (!parseResult.success) {
    console.error(
      '[booking-portal] booking page failed schema validation',
      workspaceSlug,
      slug,
      parseResult.error.flatten(),
    );
    notFound();
  }

  const host = await getHostInfo(tenant.db, bookingPage.ownerId, tenant.workspace.name);

  // Signed link from a confirmation email: open the reschedule / cancel flow
  // for that booking. Anything that does not verify falls through to the
  // normal booking page.
  let managedBooking: ManagedBooking | null = null;
  const bookingId = first(query.booking);
  const token = first(query.token);
  if (bookingId && token && (await isValidManageToken(bookingId, token))) {
    const [booking] = await tenant.db
      .select()
      .from(calendarBookings)
      .where(and(eq(calendarBookings.id, bookingId), isNull(calendarBookings.deletedAt)))
      .limit(1);
    if (booking && booking.bookingPageId === bookingPage.id) {
      managedBooking = {
        bookingId: booking.id,
        token,
        bookerName: booking.bookerName,
        bookerEmail: booking.bookerEmail,
        startTime: booking.startTime.toISOString(),
        endTime: booking.endTime.toISOString(),
        cancelled: booking.status === 'cancelled',
        intent: first(query.action) === 'cancel' ? 'cancel' : first(query.action) === 'reschedule' ? 'reschedule' : null,
      };
    }
  }

  return (
    <main className="min-h-screen bg-white md:bg-gray-50 dark:bg-[#0A0A0B] dark:md:bg-[#0A0A0B] flex items-center justify-center p-0 md:p-8">
      <BookingClient
        workspaceSlug={workspaceSlug}
        workspaceName={tenant.workspace.name}
        workspaceImage={tenant.workspace.imageUrl}
        hostName={host.name}
        bookingPage={parseResult.data}
        initialBooking={managedBooking}
      />
    </main>
  );
}
