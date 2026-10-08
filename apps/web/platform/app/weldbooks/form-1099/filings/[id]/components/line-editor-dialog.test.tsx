import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { Form1099Filing, Form1099FilingLine } from '@/lib/api/domains/weldbooks-1099';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (value: number) => `$${Number(value).toFixed(2)}`, formatDate: (v: string) => v }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { LineEditorDialog } from './line-editor-dialog';

const filing: Pick<Form1099Filing, 'id' | 'formType' | 'status'> = { id: 'f1', formType: 'nec', status: 'draft' };

function line(overrides: Partial<Form1099FilingLine> = {}): Form1099FilingLine {
  return {
    id: 'l1',
    filingId: 'f1',
    partyId: 'p1',
    partyName: 'Acme Plumbing',
    recipient: { name: 'Acme Plumbing LLC', tinType: 'ein', tinLast4: '6789' },
    hasTin: true,
    boxes: { nec_1: 2500 },
    adjustments: null,
    federalWithheld: '0.00',
    stateCode: null,
    stateIdNumber: null,
    stateIncome: null,
    stateWithheld: null,
    status: 'included',
    excludedReason: null,
    isCorrected: false,
    correctionOfLineId: null,
    deliveryMethod: null,
    deliveredAt: null,
    superseded: false,
    pendingCorrection: false,
    stateHint: null,
    ...overrides,
  };
}

function renderDialog(target: Form1099FilingLine, currentFiling = filing) {
  const onOpenChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <LineEditorDialog filing={currentFiling} line={target} onOpenChange={onOpenChange} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  api.patch.mockReset();
  api.patch.mockResolvedValue({ data: { filing: { ...filing, lineCount: 1, totals: { amount: 0, withheld: 0 }, statusCounts: {} }, lines: [line()] } });
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(cleanup);

describe('LineEditorDialog on a draft filing', () => {
  it('sends a manual adjustment with its box, signed amount and reason', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(line());
    await user.click(screen.getByRole('button', { name: 'Add adjustment' }));
    await user.type(screen.getByLabelText('Amount'), '-125.50');
    await user.type(screen.getByLabelText('Reason'), 'Refund of the March invoice');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith('/form-1099/filings/f1/lines/l1', {
      adjustments: [{ box: 'nec_1', amount: -125.5, reason: 'Refund of the March invoice' }],
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalled();
  });

  it('refuses an adjustment without a reason and sends nothing', async () => {
    const user = userEvent.setup();
    renderDialog(line());
    await user.click(screen.getByRole('button', { name: 'Add adjustment' }));
    await user.type(screen.getByLabelText('Amount'), '50');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Give a reason.')).toBeTruthy();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('removes an existing adjustment by sending the remaining list', async () => {
    const user = userEvent.setup();
    renderDialog(line({ adjustments: [{ box: 'nec_1', amount: 50, reason: 'Late bill' }] }));
    expect(screen.getAllByTestId('adjustment-row')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Remove adjustment' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/form-1099/filings/f1/lines/l1', { adjustments: [] }));
  });

  it('leaves a recipient off the form only with a reason', async () => {
    const user = userEvent.setup();
    renderDialog(line());
    await user.click(screen.getByLabelText(/Leave this recipient off the form/));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Give a reason.')).toBeTruthy();
    expect(api.patch).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/^Reason \*/), 'Paid through payroll');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/form-1099/filings/f1/lines/l1', { status: 'excluded', excludedReason: 'Paid through payroll' }),
    );
  });

  it('closes without a request when nothing was changed', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(line());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.patch).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the amounts from the books, read only', () => {
    renderDialog(line({ boxes: { nec_1: 2500, nec_4: 100 } }));
    expect(screen.getByText('$2500.00')).toBeTruthy();
    expect(screen.getByText('$100.00')).toBeTruthy();
    expect(screen.getByText('NEC 4')).toBeTruthy();
  });

  it('says so when the server refuses the change', async () => {
    api.patch.mockRejectedValue(new Error('The filing is generated.'));
    const user = userEvent.setup();
    renderDialog(line());
    await user.click(screen.getByRole('button', { name: 'Add adjustment' }));
    await user.type(screen.getByLabelText('Amount'), '5');
    await user.type(screen.getByLabelText('Reason'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The recipient could not be updated', { description: 'The filing is generated.' }));
  });
});

describe('LineEditorDialog on a correction that has not been filed', () => {
  it('sets the boxes directly instead of adjusting them', async () => {
    const user = userEvent.setup();
    renderDialog(line({ isCorrected: true, pendingCorrection: true }), { ...filing, status: 'corrected' });
    expect(screen.queryByRole('button', { name: 'Add adjustment' })).toBeNull();
    const box = screen.getByLabelText(/^1\. Nonemployee compensation/);
    await user.clear(box);
    await user.type(box, '2400');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/form-1099/filings/f1/lines/l1', { boxes: { nec_1: 2400 } }));
  });
});
