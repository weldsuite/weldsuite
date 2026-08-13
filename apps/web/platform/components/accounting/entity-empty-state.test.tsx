import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      accounting: {
        layout: {
          noEntityTitle: 'Set up your first entity',
          noEntityDescription:
            'Create a legal entity to start using WeldBooks. Chart of accounts and tax rates for the selected jurisdiction are set up automatically.',
          createFirstEntity: 'Create entity',
        },
      },
    },
  }),
}));

vi.mock('./create-entity-dialog', () => ({
  CreateEntityDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-entity-dialog">Create entity dialog</div> : null,
}));

import { EntityEmptyState } from './entity-empty-state';

describe('EntityEmptyState', () => {
  it('renders the setup title, description, and create CTA', () => {
    render(<EntityEmptyState />);

    expect(screen.getByText('Set up your first entity')).toBeInTheDocument();
    expect(
      screen.getByText(/Create a legal entity to start using WeldBooks/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId('weldbooks-create-first-entity')).toHaveTextContent('Create entity');
  });

  it('opens the create-entity dialog when the CTA is clicked', async () => {
    const user = userEvent.setup();
    render(<EntityEmptyState />);

    expect(screen.queryByTestId('create-entity-dialog')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('weldbooks-create-first-entity'));
    expect(screen.getByTestId('create-entity-dialog')).toBeInTheDocument();
  });
});
