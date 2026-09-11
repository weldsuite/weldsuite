import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { CreateBookingPageInput, WeeklyAvailability } from '@weldsuite/personal-api-client';
import { personalApi } from '@/lib/api';
import { BOOKING_PORTAL_URL, DEFAULT_AVAILABILITY, slugify } from '@/lib/utils';

const DAYS: (keyof WeeklyAvailability)[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export function SchedulingEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [duration, setDuration] = useState(30);
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [availability, setAvailability] = useState<WeeklyAvailability>(DEFAULT_AVAILABILITY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isNew);

  useEffect(() => {
    if (isNew || !id) return;
    const pageId = id;
    let cancelled = false;
    async function load() {
      try {
        const { data } = await personalApi.bookingPages.get(pageId);
        if (cancelled) return;
        setName(data.name);
        setSlug(data.slug);
        setSlugTouched(true);
        setDuration(data.duration);
        setTimezone(data.timezone);
        setAvailability(data.availability);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load page');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id, isNew]);

  async function save() {
    setSaving(true);
    setError(null);
    const body: CreateBookingPageInput = {
      name: name.trim(),
      slug: slug.trim(),
      duration,
      timezone,
      availability,
    };
    try {
      if (isNew) {
        const { data } = await personalApi.bookingPages.create(body);
        navigate(`/scheduling/${data.id}`, { replace: true });
      } else if (id) {
        await personalApi.bookingPages.update(id, body);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save booking page');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[53px] shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-3">
          <Link to="/scheduling" className="text-sm text-muted-foreground hover:text-foreground">
            Booking
          </Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="text-sm font-semibold">{isNew ? 'New page' : name || 'Edit page'}</h1>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !name.trim() || !slug.trim()}
          className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          Save
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        <div className="mx-auto max-w-xl space-y-4">
          <label className="block text-xs font-medium text-muted-foreground">
            Name
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
            />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Public slug
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(slugify(e.target.value));
              }}
            />
          </label>
          {!isNew && slug ? (
            <p className="text-xs text-muted-foreground">
              Public URL:{' '}
              <a
                className="underline"
                href={`${BOOKING_PORTAL_URL}/p/${slug}`}
                target="_blank"
                rel="noreferrer"
              >
                {BOOKING_PORTAL_URL}/p/{slug}
              </a>
            </p>
          ) : null}
          <label className="block text-xs font-medium text-muted-foreground">
            Duration (minutes)
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              {[15, 30, 45, 60, 90, 120].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Timezone
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </label>
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">Weekly hours</div>
            <div className="space-y-2">
              {DAYS.map((day) => {
                const ranges = availability[day] ?? [];
                const enabled = ranges.length > 0;
                return (
                  <div key={day} className="flex items-center gap-3 text-sm">
                    <label className="flex w-28 items-center gap-2 capitalize">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => {
                          setAvailability((prev) => ({
                            ...prev,
                            [day]: e.target.checked ? [{ start: '09:00', end: '17:00' }] : [],
                          }));
                        }}
                      />
                      {day}
                    </label>
                    {enabled ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="time"
                          className="h-8 rounded-md border border-input px-2 text-sm"
                          value={ranges[0]?.start ?? '09:00'}
                          onChange={(e) => {
                            setAvailability((prev) => ({
                              ...prev,
                              [day]: [{ start: e.target.value, end: ranges[0]?.end ?? '17:00' }],
                            }));
                          }}
                        />
                        <span className="text-muted-foreground">to</span>
                        <input
                          type="time"
                          className="h-8 rounded-md border border-input px-2 text-sm"
                          value={ranges[0]?.end ?? '17:00'}
                          onChange={(e) => {
                            setAvailability((prev) => ({
                              ...prev,
                              [day]: [{ start: ranges[0]?.start ?? '09:00', end: e.target.value }],
                            }));
                          }}
                        />
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">Unavailable</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
