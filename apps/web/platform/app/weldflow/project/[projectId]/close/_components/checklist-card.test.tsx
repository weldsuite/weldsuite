import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import { plural as pluralFor } from '@weldsuite/i18n/plural';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    language: 'en',
    t: en,
    plural: (count: number, forms: Parameters<typeof pluralFor>[1]) => pluralFor(count, forms, 'en'),
    format: interpolate,
  }),
}));

const api = vi.hoisted(() => ({
  handOver: { mutateAsync: vi.fn(), isPending: false },
  update: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock('@/hooks/queries/use-project-closing-queries', () => ({
  useHandOver: () => api.handOver,
  closingKeys: { checklists: () => ['project-closing', 'checklist'] },
}));
vi.mock('@/hooks/queries/use-project-control-queries', () => ({ useUpdateRaidItem: () => api.update }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ChecklistCard } from './checklist-card';
import { Providers, NO_ABILITIES, contextValue, makeChecklist } from '../_lib/test-fixtures';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  api.handOver.mutateAsync.mockReset().mockResolvedValue({});
  api.update.mutateAsync.mockReset().mockResolvedValue({});
});

function setup(overrides: Parameters<typeof contextValue>[0] = {}) {
  render(
    <Providers value={contextValue(overrides)}>
      <ChecklistCard />
    </Providers>,
  );
}

describe('ChecklistCard', () => {
  it('lists every check in order with its state and detail', () => {
    setup();
    const rows = screen.getAllByRole('listitem').filter((row) => row.parentElement?.tagName === 'OL');
    expect(rows).toHaveLength(7);
    expect(within(rows[0]).getByText('All deliverables accepted by the client')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Done')).toBeInTheDocument();
    expect(within(rows[0]).getByText('2 of 2 deliverables accepted')).toBeInTheDocument();
    expect(within(rows[2]).getByText('To do')).toBeInTheDocument();
    expect(within(rows[2]).getByText('1 of 2 open items handed over')).toBeInTheDocument();
    expect(within(rows[6]).getByText('Waiting')).toBeInTheDocument();
    expect(within(rows[6]).getByText('Noor Hendriks signs off once the other checks are done.')).toBeInTheDocument();
  });

  it('marks only the open blocking checks as needed before sign-off', () => {
    setup();
    expect(screen.getAllByText(/Needed before sign-off/)).toHaveLength(2);
  });

  it('shows the accepted deliverables as chips with their date, and the others with their status', () => {
    setup();
    const accepted = screen.getByRole('list', { name: 'Accepted deliverables' });
    expect(within(accepted).getByText('D1')).toBeInTheDocument();
    expect(within(accepted).getByText(/Nov/)).toBeInTheDocument();
    const open = screen.getByRole('list', { name: 'Deliverables still open' });
    expect(within(open).getByText('In progress')).toBeInTheDocument();
  });

  it('lists the open register items with owner and hand-over state', () => {
    setup();
    const list = screen.getByRole('list', { name: 'Open register items' });
    expect(within(list).getByText('SSO outage')).toBeInTheDocument();
    expect(within(list).getByText('Handed over')).toBeInTheDocument();
    expect(within(list).getByText('Owner: Sanne Jansen')).toBeInTheDocument();
    expect(within(list).getByText('No owner')).toBeInTheDocument();
  });

  it('hands an item over to the chosen person', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Hand over A-2: Content by week 8' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hand over A-2' });
    // The sponsor is the default new owner.
    expect(within(dialog).getByRole('combobox', { name: 'New owner' })).toHaveTextContent('Noor Hendriks');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'New owner' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Daan Bakker' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hand over' }));
    expect(api.handOver.mutateAsync).toHaveBeenCalledWith({ raidItems: [{ id: 'r2', ownerId: 'u_daan' }] });
  });

  it('closes an item with the closed status of its kind after a confirmation', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Close A-2: Content by week 8' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close A-2?' });
    expect(dialog).toHaveTextContent('Validated');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close item' }));
    expect(api.update.mutateAsync).toHaveBeenCalledWith({ id: 'r2', data: { status: 'validated' } });
  });

  it('uses the closed status for a risk', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Close R-5: SSO outage' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close item' }));
    expect(api.update.mutateAsync).toHaveBeenCalledWith({ id: 'r1', data: { status: 'closed' } });
  });

  it('offers no actions to someone who does not manage the project', () => {
    setup({ abilities: NO_ABILITIES, isManager: false, checklist: makeChecklist() });
    expect(screen.queryByRole('button', { name: /Hand over/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Close/ })).not.toBeInTheDocument();
    expect(screen.getByText('SSO outage')).toBeInTheDocument();
  });
});
