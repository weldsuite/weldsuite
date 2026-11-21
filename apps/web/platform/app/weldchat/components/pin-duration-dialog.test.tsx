import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        pinDuration: {
          title: 'Pin message',
          keepPinned: 'Keep pinned',
          until: 'Until {date}',
          unpinOn: 'Unpin on',
          selectDate: 'Select date',
          notify: 'Notify everyone in the chat',
          cancel: 'Cancel',
          pin: 'Pin',
          durations: { h24: '24 hours', d7: '7 days', d30: '30 days', custom: 'Custom date', forever: 'Forever' },
        },
      },
    },
  }),
}));
vi.mock('@/lib/i18n/date-locale', () => ({ useDateLocale: () => ({ intlLocale: 'en-GB', dateFnsLocale: undefined }) }));

import { PinDurationDialog, pinExpiresAt } from './pin-duration-dialog';

const NOW = new Date('2026-11-21T16:00:00Z');

afterEach(cleanup);

describe('pinExpiresAt', () => {
  it('ends a timed pin that long from now', () => {
    expect(pinExpiresAt('24h', NOW)?.toISOString()).toBe('2026-11-22T16:00:00.000Z');
    expect(pinExpiresAt('7d', NOW)?.toISOString()).toBe('2026-11-28T16:00:00.000Z');
    expect(pinExpiresAt('30d', NOW)?.toISOString()).toBe('2026-12-21T16:00:00.000Z');
  });

  it('keeps a forever pin, and ends a custom one on its date', () => {
    expect(pinExpiresAt('forever', NOW)).toBeUndefined();
    expect(pinExpiresAt('custom', NOW)).toBeUndefined();
    const date = new Date('2026-12-01T00:00:00Z');
    expect(pinExpiresAt('custom', NOW, date)).toBe(date);
  });
});

describe('PinDurationDialog', () => {
  function renderDialog() {
    const onPin = vi.fn();
    const onOpenChange = vi.fn();
    render(<PinDurationDialog open onOpenChange={onOpenChange} onPin={onPin} />);
    return { onPin, onOpenChange };
  }

  it('pins forever and tells the chat, by default', () => {
    const { onPin, onOpenChange } = renderDialog();
    expect(screen.getByRole('combobox', { name: 'Keep pinned' }).textContent).toContain('Forever');
    expect(screen.getByRole('switch', { name: 'Notify everyone in the chat' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(onPin).toHaveBeenCalledWith(undefined, true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('pins without a notice once the switch is off', () => {
    const { onPin } = renderDialog();
    fireEvent.click(screen.getByRole('switch', { name: 'Notify everyone in the chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(onPin).toHaveBeenCalledWith(undefined, false);
  });

  it('closes without pinning on Cancel', () => {
    const { onPin, onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onPin).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
