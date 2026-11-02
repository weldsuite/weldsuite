import { afterEach, describe, expect, it } from 'vitest';
import { HOME_WIDGETS, isWidgetEnabled, isWidgetOffered } from './registry';
import { setRuntimeConfig } from '@/lib/runtime-config';

afterEach(() => setRuntimeConfig(null));

describe('home widgets · edition flags', () => {
  it('offers every widget on Global', () => {
    for (const def of Object.values(HOME_WIDGETS)) expect(isWidgetOffered(def), def.id).toBe(true);
  });

  it('offers only the widgets of served modules on the EU edition', () => {
    setRuntimeConfig({
      backend: 'rust',
      modules: ['core', 'know', 'sign', 'pass', 'calendar'],
      unavailableFeatures: ['analytics'],
    });
    expect(isWidgetOffered(HOME_WIDGETS['weldcalendar-week'])).toBe(true);
    expect(isWidgetOffered(HOME_WIDGETS['welddrive-recent'])).toBe(true);
    expect(isWidgetOffered(HOME_WIDGETS['weldmail-inbox'])).toBe(false);
    expect(isWidgetOffered(HOME_WIDGETS['weldflow-my-tasks'])).toBe(false);
    expect(isWidgetOffered(HOME_WIDGETS['analytics-activity'])).toBe(false);
    expect(isWidgetEnabled('weldmail-inbox')).toBe(false);
  });
});
