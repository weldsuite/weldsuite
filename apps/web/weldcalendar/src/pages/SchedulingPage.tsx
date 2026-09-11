import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { BookingPage } from '@weldsuite/personal-api-client';
import { personalApi } from '@/lib/api';
import { BOOKING_PORTAL_URL } from '@/lib/utils';

export function SchedulingPage() {
  const [pages, setPages] = useState<BookingPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { data } = await personalApi.bookingPages.list({ limit: 50 });
        if (!cancelled) setPages(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load booking pages');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[53px] shrink-0 items-center justify-between border-b border-border px-4">
        <h1 className="text-sm font-semibold">Booking pages</h1>
        <Link
          to="/scheduling/new"
          className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" />
          New page
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {!loading && pages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Create a public booking page so people can schedule time with you.
          </p>
        ) : null}
        <div className="space-y-2">
          {pages.map((page) => (
            <Link
              key={page.id}
              to={`/scheduling/${page.id}`}
              className="block rounded-lg border border-border p-4 hover:bg-muted/40"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">{page.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {page.duration} min · {page.timezone}
                    {page.isActive ? '' : ' · unpublished'}
                  </div>
                </div>
                <code className="truncate text-xs text-muted-foreground">
                  {BOOKING_PORTAL_URL}/p/{page.slug}
                </code>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
