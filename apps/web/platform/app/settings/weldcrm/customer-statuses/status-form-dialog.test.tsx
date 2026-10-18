import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});

import { StatusFormDialog } from './status-form-dialog';

const ts = en.crm.settings.customerStatuses;

function renderDialog(onSubmit = vi.fn()) {
  render(<StatusFormDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} isPending={false} />);
  return onSubmit;
}

describe('StatusFormDialog slug conflicts (TASK-1031)', () => {
  it('explains that a built-in slug is reserved, without calling the API', async () => {
    const onSubmit = renderDialog();
    await userEvent.type(screen.getByLabelText(ts.form.name), 'Active');
    await userEvent.click(screen.getByRole('button', { name: ts.form.create }));

    expect(await screen.findByText(ts.form.slugReserved.replace('{slug}', 'active'))).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a 409 from the API on the Slug field', async () => {
    const onSubmit = renderDialog(vi.fn().mockRejectedValue(new ApiError("Slug 'on_hold' is already in use", 409)));
    await userEvent.type(screen.getByLabelText(ts.form.name), 'On hold');
    await userEvent.click(screen.getByRole('button', { name: ts.form.create }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(await screen.findByText(ts.form.slugTaken.replace('{slug}', 'on_hold'))).toBeInTheDocument();
  });
});
