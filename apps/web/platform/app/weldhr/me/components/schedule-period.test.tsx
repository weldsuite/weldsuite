import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { MY_PERIODS, PeriodSelect, periodRange } from './schedule-period';

const t = en.weldhr.me.schedule.period;

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 18, 10, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('periodRange', () => {
  it('spans the last 30 days and the next 2 weeks by default', () => {
    expect(periodRange('around')).toEqual({ from: '2026-10-20', to: '2026-12-02' });
  });

  it('spans the current calendar month', () => {
    expect(periodRange('thisMonth')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('spans the previous calendar month', () => {
    expect(periodRange('lastMonth')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('spans the last 92 days up to today, the most the API accepts', () => {
    expect(periodRange('last3Months')).toEqual({ from: '2026-08-19', to: '2026-11-18' });
  });
});

describe('PeriodSelect', () => {
  it('shows the picked period and reports another one', async () => {
    const onChange = vi.fn();
    render(
      <I18nProvider initialLanguage="en">
        <PeriodSelect value="thisMonth" onChange={onChange} />
      </I18nProvider>,
    );
    const trigger = screen.getByRole('combobox', { name: t.label });
    expect(trigger).toHaveTextContent(t.thisMonth);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(trigger);
    for (const period of MY_PERIODS) expect(screen.getByRole('option', { name: t[period] })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: t.lastMonth }));
    expect(onChange).toHaveBeenCalledWith('lastMonth');
  });
});
