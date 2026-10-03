/**
 * Breadcrumb trail of the WeldCalendar header.
 *
 * Generic paths turn each URL segment into a label. The scheduling routes need
 * more: the segment after `/scheduling` is a booking page id (or the `new` /
 * `__draft__` placeholders), which must never be shown raw. They resolve to the
 * booking page's name instead.
 */

export interface CalendarCrumb {
  label: string;
  href: string;
}

export interface CalendarBreadcrumbContext {
  /** Name of the booking page in the URL, once loaded. */
  bookingPageName?: string | null;
  labels: {
    root: string;
    scheduling: string;
    /** Draft / not yet created booking page. */
    newBookingPage: string;
    /** Used while the page name is still loading. */
    bookingPage: string;
    details: string;
    edit: string;
  };
}

const SCHEDULING_BASE = '/weldcalendar/scheduling';

/** `/weldcalendar/scheduling/<id>[/view|/edit]` -> the booking page id, or null. */
export function schedulingPageIdFromPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'weldcalendar' || parts[1] !== 'scheduling') return null;
  const id = parts[2];
  if (!id || id === 'new' || id === '__draft__') return null;
  return id;
}

function titleCase(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
}

export function buildCalendarBreadcrumbs(pathname: string, ctx: CalendarBreadcrumbContext): CalendarCrumb[] {
  const { labels } = ctx;
  const crumbs: CalendarCrumb[] = [{ label: labels.root, href: '/weldcalendar' }];
  const parts = pathname.split('/').filter(Boolean);

  if (parts[0] === 'weldcalendar' && parts[1] === 'scheduling') {
    crumbs.push({ label: labels.scheduling, href: SCHEDULING_BASE });
    const id = parts[2];
    if (!id) return crumbs;

    if (id === 'new' || id === '__draft__') {
      crumbs.push({ label: labels.newBookingPage, href: `${SCHEDULING_BASE}/new` });
      return crumbs;
    }

    const viewHref = `${SCHEDULING_BASE}/${id}/view`;
    crumbs.push({ label: ctx.bookingPageName?.trim() || labels.bookingPage, href: viewHref });
    const sub = parts[3];
    if (sub === 'edit') crumbs.push({ label: labels.edit, href: `${SCHEDULING_BASE}/${id}/edit` });
    else if (sub !== 'view') crumbs.push({ label: labels.details, href: `${SCHEDULING_BASE}/${id}` });
    return crumbs;
  }

  for (let i = 1; i < parts.length; i++) {
    crumbs.push({ label: titleCase(parts[i]), href: '/' + parts.slice(0, i + 1).join('/') });
  }
  return crumbs;
}
