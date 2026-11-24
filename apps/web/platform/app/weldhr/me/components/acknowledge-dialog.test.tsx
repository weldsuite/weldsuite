import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { AcknowledgeDialog, type AcknowledgeTarget } from './acknowledge-dialog';

const mocks = vi.hoisted(() => ({
  evaluation: vi.fn(),
  coaching: vi.fn(),
  toastSuccess: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: (message: string) => mocks.toastSuccess(message), error: vi.fn() } }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrAcknowledgeEvaluation: () => ({ mutateAsync: mocks.evaluation }),
  useMyHrAcknowledgeCoaching: () => ({ mutateAsync: mocks.coaching }),
}));

function renderDialog(target: AcknowledgeTarget) {
  return render(
    <I18nProvider initialLanguage="en">
      <AcknowledgeDialog target={target} onClose={mocks.onClose} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.evaluation.mockReset().mockResolvedValue(undefined);
  mocks.coaching.mockReset().mockResolvedValue(undefined);
  mocks.toastSuccess.mockReset();
  mocks.onClose.mockReset();
});

describe('AcknowledgeDialog', () => {
  it('acknowledges an evaluation with the trimmed comment', async () => {
    const user = userEvent.setup();
    renderDialog({ kind: 'evaluation', id: 'ev_1' });

    expect(screen.getByRole('heading', { name: 'Acknowledge this evaluation' })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Add a comment (optional)'), '  Thanks  ');
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));

    await waitFor(() => expect(mocks.evaluation).toHaveBeenCalledWith({ id: 'ev_1', comment: 'Thanks' }));
    expect(mocks.coaching).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Acknowledged');
    expect(mocks.onClose).toHaveBeenCalled();
  });

  it('acknowledges a coaching session, and sends no comment when it is blank', async () => {
    const user = userEvent.setup();
    renderDialog({ kind: 'coaching', id: 'co_1' });

    expect(screen.getByRole('heading', { name: 'Acknowledge this coaching session' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));

    await waitFor(() => expect(mocks.coaching).toHaveBeenCalledWith({ id: 'co_1', comment: null }));
    expect(mocks.evaluation).not.toHaveBeenCalled();
    expect(mocks.onClose).toHaveBeenCalled();
  });

  it('shows the failure, can dismiss it, and stays open', async () => {
    mocks.evaluation.mockRejectedValue(new Error('Already acknowledged'));
    const user = userEvent.setup();
    renderDialog({ kind: 'evaluation', id: 'ev_1' });

    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText('Already acknowledged')).toBeInTheDocument();
    expect(mocks.onClose).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('refuses a comment over 5000 characters', async () => {
    const user = userEvent.setup();
    renderDialog({ kind: 'evaluation', id: 'ev_1' });

    await user.click(screen.getByPlaceholderText('Add a comment (optional)'));
    await user.paste('x'.repeat(5001));
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));

    expect(await screen.findByText('Keep your comment under 5000 characters.')).toBeInTheDocument();
    expect(mocks.evaluation).not.toHaveBeenCalled();
  });

  it('closes from Cancel and from Escape', async () => {
    const user = userEvent.setup();
    renderDialog({ kind: 'coaching', id: 'co_1' });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.onClose).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(mocks.onClose).toHaveBeenCalledTimes(2);
  });
});
