import { afterEach, describe, expect, it } from 'vitest';
import { HOME_WIDGETS, isWidgetEnabled, isWidgetOffered } from './registry';
import { setRuntimeConfig } from '@/lib/runtime-config';

afterEach(() => setRuntimeConfig(null));

describe('home widgets · coming soon', () => {
  it('lists the activity chart but never enables it while it only has sample data (TASK-976)', () => {
    const def = HOME_WIDGETS['analytics-activity'];
    expect(def.disabled).toBe(true);
    expect(isWidgetOffered(def)).toBe(true);
    expect(isWidgetEnabled('analytics-activity')).toBe(false);
  });

  it('keeps the real-data widgets enabled', () => {
    expect(isWidgetEnabled('weldmail-inbox')).toBe(true);
    expect(isWidgetEnabled('weldflow-my-tasks')).toBe(true);
  });
});

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
