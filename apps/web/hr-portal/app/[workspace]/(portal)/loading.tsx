import { PageSkeleton } from '@/components/page-skeleton';

/**
 * Loading boundary for the signed-in area. Also lets Next.js prefetch each
 * route's shell ahead of the click. Pages add their own Suspense boundary
 * (see any page.tsx): during a navigation React keeps an already-visible
 * boundary on the old content, so only a fresh per-page boundary shows the
 * skeleton immediately.
 */
export default function PortalLoading() {
  return <PageSkeleton />;
}
