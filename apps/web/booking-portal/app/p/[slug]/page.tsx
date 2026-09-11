import { eq, and, isNull } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { personalCalendarBookingPages } from '@weldsuite/db/schema/personal';
import { personalAccounts } from '@weldsuite/db/schema/master';
import { masterDb } from '@weldsuite/db/lib/master';

import { getPersonalDb } from '@/lib/db';
import { bookingPagePropsSchema } from '@/lib/schemas';
import { BookingClient } from '../../[workspace]/[slug]/booking-client';

type Props = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  try {
    const db = getPersonalDb();
    const [page] = await db
      .select({
        name: personalCalendarBookingPages.name,
        description: personalCalendarBookingPages.description,
        personalAccountId: personalCalendarBookingPages.personalAccountId,
      })
      .from(personalCalendarBookingPages)
      .where(
        and(
          eq(personalCalendarBookingPages.slug, slug),
          eq(personalCalendarBookingPages.isActive, true),
          isNull(personalCalendarBookingPages.deletedAt),
        ),
      )
      .limit(1);

    if (!page) return { title: 'Not Found' };

    const [account] = await masterDb
      .select({ displayName: personalAccounts.displayName })
      .from(personalAccounts)
      .where(eq(personalAccounts.id, page.personalAccountId))
      .limit(1);

    const host = account?.displayName?.trim() || 'WeldCalendar';
    return {
      title: `${page.name} — ${host}`,
      description: page.description || `Book a meeting: ${page.name}`,
    };
  } catch {
    return { title: 'Not Found' };
  }
}

export default async function PersonalBookingPage({ params }: Props) {
  const { slug } = await params;
  let db;
  try {
    db = getPersonalDb();
  } catch {
    notFound();
  }

  const [bookingPage] = await db
    .select()
    .from(personalCalendarBookingPages)
    .where(
      and(
        eq(personalCalendarBookingPages.slug, slug),
        eq(personalCalendarBookingPages.isActive, true),
        isNull(personalCalendarBookingPages.deletedAt),
      ),
    )
    .limit(1);

  if (!bookingPage) notFound();

  const [account] = await masterDb
    .select({ displayName: personalAccounts.displayName })
    .from(personalAccounts)
    .where(eq(personalAccounts.id, bookingPage.personalAccountId))
    .limit(1);

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
    availability: bookingPage.availability,
    questions: bookingPage.questions ?? [],
    minNotice: bookingPage.minNotice,
    maxAdvance: bookingPage.maxAdvance,
    confirmationMessage: bookingPage.confirmationMessage,
    timezone: bookingPage.timezone || 'UTC',
  });

  if (!parseResult.success) {
    console.error(
      '[booking-portal] personal booking page failed schema validation',
      slug,
      parseResult.error.flatten(),
    );
    notFound();
  }

  const hostName = account?.displayName?.trim() || 'WeldCalendar';

  return (
    <main className="min-h-screen bg-white md:bg-gray-50 dark:bg-[#0A0A0B] dark:md:bg-[#0A0A0B] flex items-center justify-center p-0 md:p-8">
      <BookingClient
        kind="personal"
        workspaceName={hostName}
        workspaceImage={null}
        bookingPage={parseResult.data}
      />
    </main>
  );
}
