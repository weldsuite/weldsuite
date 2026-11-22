import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  settings: {
    isPending: false,
    isError: false,
    data: { data: { companyId: 'cmp_1', approvalThreshold: '2500.00', approvalThresholdCurrency: 'EUR' } } as unknown,
  },
  save: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: env.success, error: env.error } }));
vi.mock('@/hooks/queries/use-commerce-buyers-queries', () => ({
  useCompanyCommerceSettings: () => env.settings,
  useUpdateCompanyCommerceSettings: () => ({ mutateAsync: env.save }),
}));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useCommerceSettings: () => ({ data: { data: { defaultCurrency: 'USD' } } }),
}));

import { ApprovalThreshold } from './company-approval-threshold';

function give(approvalThreshold: string | null, approvalThresholdCurrency: string | null) {
  env.settings = { isPending: false, isError: false, data: { data: { companyId: 'cmp_1', approvalThreshold, approvalThresholdCurrency } } };
}

beforeEach(() => {
  give('2500.00', 'EUR');
  env.save.mockReset();
  env.save.mockResolvedValue({ data: {} });
  env.success.mockReset();
  env.error.mockReset();
});

describe('ApprovalThreshold', () => {
  it('shows the saved threshold with its currency', () => {
    render(<ApprovalThreshold companyId="cmp_1" canEdit />);
    expect(screen.getByRole('heading', { name: 'Approval threshold' })).toBeTruthy();
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('2500.00');
    expect((screen.getByLabelText('Currency') as HTMLInputElement).value).toBe('EUR');
  });

  it('starts empty with the workspace currency when there is no threshold', () => {
    give(null, null);
    render(<ApprovalThreshold companyId="cmp_1" canEdit />);
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Currency') as HTMLInputElement).value).toBe('USD');
  });

  it('saves a new amount in the contract’s shape', async () => {
    const user = userEvent.setup();
    render(<ApprovalThreshold companyId="cmp_1" canEdit />);
    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '3000');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.save).toHaveBeenCalled());
    expect(env.save).toHaveBeenCalledWith({ approvalThreshold: '3000.00', approvalThresholdCurrency: 'EUR' });
    expect(env.success).toHaveBeenCalledWith('Approval threshold saved');
  });

  it('saves an empty amount as no approval, whatever the currency says', async () => {
    const user = userEvent.setup();
    render(<ApprovalThreshold companyId="cmp_1" canEdit />);
    await user.clear(screen.getByLabelText('Amount'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.save).toHaveBeenCalled());
    expect(env.save).toHaveBeenCalledWith({ approvalThreshold: null, approvalThresholdCurrency: null });
  });

  it('checks the amount and the currency before sending', async () => {
    const user = userEvent.setup();
    render(<ApprovalThreshold companyId="cmp_1" canEdit />);
    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '12,5');
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'e');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter an amount such as 1500 or 1500.50.')).toBeTruthy();
    expect(screen.getByText('Enter a three-letter currency code, such as EUR.')).toBeTruthy();
    expect(env.save).not.toHaveBeenCalled();
  });

  it('reports a failed save', async () => {
    env.save.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    render(<ApprovalThreshold companyId="cmp_1" canEdit />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.error).toHaveBeenCalledWith('nope'));
  });

  it('is read-only without companies:update: no Save, the fields cannot be typed in', () => {
    render(<ApprovalThreshold companyId="cmp_1" canEdit={false} />);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect((screen.getByLabelText('Amount') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText('You can view the threshold but not change it.')).toBeTruthy();
  });

  it('shows a failure to load in words', () => {
    env.settings = { isPending: false, isError: true, data: undefined };
    render(<ApprovalThreshold companyId="cmp_1" canEdit />);
    expect(screen.getByText('Could not load the approval threshold.')).toBeTruthy();
    expect(screen.queryByLabelText('Amount')).toBeNull();
  });
});
