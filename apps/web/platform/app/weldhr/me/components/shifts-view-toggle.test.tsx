import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { ShiftsViewToggle } from './shifts-view-toggle';

const t = en.weldhr.me.schedule.view;

function renderToggle(value: 'list' | 'calendar', onChange = vi.fn()) {
  render(
    <I18nProvider initialLanguage="en">
      <ShiftsViewToggle value={value} onChange={onChange} />
    </I18nProvider>,
  );
  return onChange;
}

describe('ShiftsViewToggle', () => {
  it('marks the current view as pressed', () => {
    renderToggle('calendar');
    expect(screen.getByRole('radio', { name: t.calendar })).toBeChecked();
    expect(screen.getByRole('radio', { name: t.list })).not.toBeChecked();
  });

  it('switches to the other view', async () => {
    const onChange = renderToggle('list');
    await userEvent.setup().click(screen.getByRole('radio', { name: t.calendar }));
    expect(onChange).toHaveBeenCalledWith('calendar');
  });

  it('keeps the view when the pressed one is pressed again', async () => {
    const onChange = renderToggle('list');
    await userEvent.setup().click(screen.getByRole('radio', { name: t.list }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
