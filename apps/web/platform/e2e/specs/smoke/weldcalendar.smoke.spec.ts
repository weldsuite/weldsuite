import { test } from '../../fixtures';
import { smokeRoute } from '../../helpers/smoke';

const routes = [
  '/weldcalendar',
  '/weldcalendar/events',
  '/weldcalendar/scheduling',
  '/weldcalendar/scheduling/new',
];

test.describe('WeldCalendar · smoke', () => {
  for (const path of routes) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      await smokeRoute(page, { path });
    });
  }
});
