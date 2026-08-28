import { Hono } from 'hono';
import type { Env, Variables } from '../index';
import { success } from '../lib/response';

export const configRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

configRoutes.get('/', async (c) => {
  const widgetConfig = c.get('widgetConfig');
  const branding = widgetConfig.branding ?? {};
  return success(c, {
    widgetId: widgetConfig.widgetId,
    enabled: widgetConfig.enabled,
    greeting: widgetConfig.greeting ?? 'Hi — how can we help?',
    branding: {
      primaryColor: branding.primaryColor ?? '#2563eb',
      backgroundColor: branding.backgroundColor ?? '#ffffff',
      position: branding.position ?? 'right',
    },
    showBranding: !c.get('removeBranding'),
  });
});
