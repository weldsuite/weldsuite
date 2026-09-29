/**
 * WeldSuite calendar-api — the WeldCalendar (calendars, calendar events,
 * bookings, booking pages, working hours) module's API worker, plus the
 * daily calendar replan cron.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { runCalendarReplanSweep } from './cron/calendar-replan';
import { bookingPagesRoutes } from './routes/booking-pages';
import { bookingsRoutes } from './routes/bookings';
import { calendarEventsRoutes } from './routes/calendar-events';
import { calendarsRoutes } from './routes/calendars';
import { workingHoursRoutes } from './routes/working-hours';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'calendar-api' });

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/booking-pages', bookingPagesRoutes);
app.route('/api/bookings', bookingsRoutes);
app.route('/api/calendar-events', calendarEventsRoutes);
app.route('/api/calendars', calendarsRoutes);
app.route('/api/working-hours', workingHoursRoutes);

export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // Daily at 04:00 UTC: re-plan stale auto-scheduled calendar events.
    if (event.cron === '0 4 * * *') {
      ctx.waitUntil(
        runCalendarReplanSweep(env).catch((err) => {
          console.error('[CalendarReplan] Failed:', err);
        }),
      );
    }
  },
};
