import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithApp, stubRadixBrowserApis } from '@/app/weldreach/components/engage/test-utils';

const reach = vi.hoisted(() => ({ addToCrm: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ reach }) }));
vi.mock('@/hooks/use-user-idle', () => ({ useIdleAwareRefetchInterval: () => false }));
vi.mock('@/hooks/queries/use-pipelines-queries', () => {
  const stages = [
    { id: 'st_won', name: 'Won', pipeline: 'pl_1', position: 9, isWon: true },
    { id: 'st_new', name: 'Qualified', pipeline: 'pl_1', position: 1 },
    { id: 'st_p', name: 'Intro call', pipeline: 'pl_2', position: 1 },
  ];
  return {
    usePipelines: () => ({
      data: {
        data: [
          { id: 'pl_2', name: 'Partners' },
          { id: 'pl_1', name: 'Sales', isDefault: true },
          { id: 'pl_old', name: 'Old', isArchived: true },
        ],
      },
      isLoading: false,
    }),
    usePipelineStages: () => ({ data: { data: stages } }),
  };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { AddToCrmDialog } from './add-to-crm-dialog';

function mount(onClose = vi.fn()) {
  renderWithApp(<AddToCrmDialog threadKey="thr_1" prospectLabel="Ana Jansen" onClose={onClose} />);
  return onClose;
}

beforeAll(stubRadixBrowserApis);

beforeEach(() => {
  reach.addToCrm.mockReset();
  reach.addToCrm.mockResolvedValue({ data: { personId: 'per_1', opportunityId: null } });
  toast.success.mockReset();
});

describe('AddToCrmDialog', () => {
  it('adds only the person by default', async () => {
    const user = userEvent.setup();
    const onClose = mount();

    expect(screen.getByText(/Creates a CRM person for Ana Jansen/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add to CRM' }));

    await waitFor(() => expect(reach.addToCrm).toHaveBeenCalledWith('thr_1', {}));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Added to the CRM.');
  });

  it('starts an opportunity on the default pipeline at its first open stage', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('switch', { name: 'Also create an opportunity' }));

    expect(await screen.findByRole('combobox', { name: 'Pipeline' })).toHaveTextContent('Sales');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Stage' })).toHaveTextContent('Qualified'));
    // An archived pipeline is not offered.
    await user.click(screen.getByRole('combobox', { name: 'Pipeline' }));
    expect(screen.queryByRole('option', { name: 'Old' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.type(screen.getByLabelText('Opportunity name'), '  Payroll rollout ');
    await user.click(screen.getByRole('button', { name: 'Add to CRM' }));

    await waitFor(() =>
      expect(reach.addToCrm).toHaveBeenCalledWith('thr_1', {
        opportunity: { pipelineId: 'pl_1', stageId: 'st_new', name: 'Payroll rollout' },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Added to the CRM with an opportunity.');
  });

  it('moves to the first stage of another pipeline when the pipeline changes', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('switch', { name: 'Also create an opportunity' }));
    await user.click(await screen.findByRole('combobox', { name: 'Pipeline' }));
    await user.click(await screen.findByRole('option', { name: 'Partners' }));

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Stage' })).toHaveTextContent('Intro call'));
    await user.click(screen.getByRole('button', { name: 'Add to CRM' }));
    await waitFor(() =>
      expect(reach.addToCrm).toHaveBeenCalledWith('thr_1', {
        opportunity: { pipelineId: 'pl_2', stageId: 'st_p' },
      }),
    );
  });

  it('keeps the dialog open and shows the reason when the CRM refuses', async () => {
    const user = userEvent.setup();
    reach.addToCrm.mockRejectedValue(new Error('You do not have access to the CRM.'));
    const onClose = mount();

    await user.click(screen.getByRole('button', { name: 'Add to CRM' }));

    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('You do not have access to the CRM.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
