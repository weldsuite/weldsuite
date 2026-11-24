import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('PinDurationDialog durations', () => {
  beforeAll(() => {
    // Radix Select scrolls the picked option into view; jsdom has no layout.
    Element.prototype.scrollIntoView ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderDialog() {
    const onPin = vi.fn();
    render(<PinDurationDialog open onOpenChange={vi.fn()} onPin={onPin} />);
    return { onPin };
  }

  /** Opens the duration select and picks the option named `name`. */
  function choose(name: string) {
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Keep pinned' }), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('option', { name: new RegExp(`^${name}`) }), { key: 'Enter' });
  }

  it('says until when each timed choice keeps the message pinned', () => {
    renderDialog();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Keep pinned' }), { key: 'ArrowDown' });
    // 24 hours names the time too; the longer pins name the day alone.
    expect(screen.getByRole('option', { name: /^24 hours/ }).textContent).toMatch(/Until Sun,? 22 Nov, \d{2}:\d{2}/);
    expect(screen.getByRole('option', { name: /^7 days/ }).textContent).toMatch(/Until Sat,? 28 Nov$/);
    expect(screen.getByRole('option', { name: /^Forever/ }).textContent).not.toContain('Until');
  });

  it('pins for 24 hours from now', () => {
    const { onPin } = renderDialog();
    choose('24 hours');
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(onPin).toHaveBeenCalledWith('2026-11-22T16:00:00.000Z', true);
  });

  it('needs a day for a custom end, from tomorrow on', () => {
    const { onPin } = renderDialog();
    choose('Custom date');

    expect(screen.getByRole('button', { name: 'Pin' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Unpin on' }));
    // The field is named by its label. Today (21 November) can't be picked; 25 November can.
    expect(screen.getByText('21').closest('button')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByText('25'));

    const pin = screen.getByRole('button', { name: 'Pin' });
    expect(pin).toHaveProperty('disabled', false);
    fireEvent.click(pin);
    expect(onPin).toHaveBeenCalledWith(new Date(2026, 10, 25).toISOString(), true);
  });
});
