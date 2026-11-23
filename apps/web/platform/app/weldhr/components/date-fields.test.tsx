import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));

import { HrTimeInput } from './date-fields';

const CLEAR = 'common.ui.form.clear';

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
