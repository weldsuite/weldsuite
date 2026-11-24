import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setHrFormatLocale } from '@/app/weldhr/components/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));

vi.mock('@/lib/i18n/date-locale', async () => {
  const { enUS } = await import('date-fns/locale/en-US');
  return { useDateLocale: () => ({ dateFnsLocale: enUS }) };
});

import { HrDateInput, HrTimeInput } from './date-fields';

const CLEAR = 'common.ui.form.clear';

// The dates below read as WeldHR writes them in en-GB, whatever the machine's locale.
beforeAll(() => setHrFormatLocale('en-GB'));
afterAll(() => setHrFormatLocale(undefined));

describe('HrTimeInput', () => {
  it('empties an optional time with Clear', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HrTimeInput id="break-start" value="12:30" clearable onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /12:30/ }));
    await user.click(screen.getByRole('button', { name: CLEAR }));

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('has no Clear on a time the form needs', async () => {
    const user = userEvent.setup();
    render(<HrTimeInput id="shift-start" value="09:00" onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /09:00/ }));

    expect(screen.getByText('weldhr.common.hour')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument();
  });

  it('has no Clear while an optional time is empty', async () => {
    const user = userEvent.setup();
    render(<HrTimeInput id="break-end" value="" clearable onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /weldhr.common.pickTime/ }));

    expect(screen.getByText('weldhr.common.hour')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument();
  });
});

describe('HrDateInput', () => {
  it('shows the plain date the way the WeldHR lists do', () => {
    render(<HrDateInput value="2026-11-22" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /22 Nov 2026/ })).toBeInTheDocument();
  });

  it('shows the placeholder without a date, and a custom one when given', () => {
    const { unmount } = render(<HrDateInput value="" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /weldhr.common.pickDate/ })).toBeInTheDocument();
    unmount();
    render(<HrDateInput value={null} placeholder="Start date" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Start date/ })).toBeInTheDocument();
  });

  it('reads a date without shifting it with the time zone', () => {
    render(<HrDateInput value="2026-01-01" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /1 Jan 2026/ })).toBeInTheDocument();
  });

  it('reports the picked day as YYYY-MM-DD', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HrDateInput value="2026-11-22" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /22 Nov 2026/ }));
    await user.click(screen.getByRole('button', { name: /November 24th, 2026/ }));
    expect(onChange).toHaveBeenCalledWith('2026-11-24');
  });

  it('empties the date when the selected day is picked again', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HrDateInput value="2026-11-22" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /22 Nov 2026/ }));
    await user.click(screen.getByRole('button', { name: /November 22nd, 2026/ }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('disables the days outside min and max', async () => {
    const user = userEvent.setup();
    render(<HrDateInput value="2026-11-15" min="2026-11-10" max="2026-11-20" onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /15 Nov 2026/ }));
    expect(screen.getByRole('button', { name: /November 9th, 2026/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /November 21st, 2026/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /November 15th, 2026/ })).toBeEnabled();
  });

  it('limits only one side when only min or only max is given', async () => {
    const user = userEvent.setup();
    render(<HrDateInput value="2026-11-15" max="2026-11-20" onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /15 Nov 2026/ }));
    expect(screen.getByRole('button', { name: /November 1st, 2026/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /November 21st, 2026/ })).toBeDisabled();
  });

  it('offers month and year menus for a year picker, from 1920 up to max', async () => {
    const user = userEvent.setup();
    render(<HrDateInput value="1990-05-10" max="2026-11-23" yearPicker onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /10 May 1990/ }));
    const years = screen.getAllByRole('combobox').find((select) => within(select).queryByRole('option', { name: '1920' }));
    expect(years).toBeDefined();
    expect(within(years!).queryByRole('option', { name: '2027' })).not.toBeInTheDocument();
    expect(within(years!).getByRole('option', { name: '2026' })).toBeInTheDocument();
  });

  it('runs a year picker without bounds from 1920 to ten years ahead', async () => {
    const user = userEvent.setup();
    render(<HrDateInput value="1990-05-10" yearPicker onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /10 May 1990/ }));
    const years = screen.getAllByRole('combobox').find((select) => within(select).queryByRole('option', { name: '1920' }));
    expect(years).toBeDefined();
    expect(within(years!).getByRole('option', { name: String(new Date().getFullYear() + 10) })).toBeInTheDocument();
  });
});
