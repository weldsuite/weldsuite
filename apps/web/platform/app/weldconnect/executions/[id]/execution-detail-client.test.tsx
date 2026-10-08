import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { ExecutionDetailDto } from './execution-detail-client';

const push = vi.fn();
const cancelMutate = vi.fn();
const retryMutate = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
let cancelPending = false;

vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en, language: 'en' }) }));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => {} }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) } }));
vi.mock('@/hooks/realtime/use-execution-realtime', () => ({
  useExecutionRealtime: () => ({ status: null, progress: null, isLive: false }),
}));
vi.mock('./approval-panel', () => ({ ApprovalPanel: () => null }));
vi.mock('@/hooks/queries/use-automation-queries', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/queries/use-automation-queries')>(
    '@/hooks/queries/use-automation-queries',
  );
  return {
    ...actual,
    useCancelExecution: () => ({ mutate: cancelMutate, isPending: cancelPending }),
    useRetryExecution: () => ({ mutate: retryMutate, isPending: false }),
  };
});

const { ExecutionDetailClient } = await import('./execution-detail-client');
const d = en.weldconnect.executionDetail;

function makeExecution(over: Partial<ExecutionDetailDto>): ExecutionDetailDto {
  return {
    id: 'wex_abc123456',
    workflowId: 'wf_1',
    workflowName: 'Notify team',
    status: 'running',
    steps: [],
    input: null,
    error: null,
    ...over,
  } as ExecutionDetailDto;
}

function step(id: string, name: string, status: string) {
  return {
    id,
    name,
    type: 'send_notification',
    status,
    duration: null,
    startedAt: null,
    completedAt: null,
    input: null,
    output: null,
    error: null,
  };
}

describe('ExecutionDetailClient: Cancel', () => {
  beforeEach(() => {
    cancelMutate.mockReset();
    retryMutate.mockReset();
    toastSuccess.mockClear();
    toastError.mockClear();
    push.mockClear();
    cancelPending = false;
  });

  it('asks in an in-app dialog (not window.confirm) before cancelling, and sends nothing until confirmed', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<ExecutionDetailClient execution={makeExecution({ status: 'running' })} initialLogs={[]} />);

    const button = screen.getByRole('button', { name: d.cancelExecution });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(d.cancelDialogTitle)).toBeTruthy();
    expect(cancelMutate).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: d.cancelDialogConfirm }));
    expect(cancelMutate).toHaveBeenCalledWith('wex_abc123456', expect.any(Object));
    confirmSpy.mockRestore();
  });

  it('does not cancel when the dialog is dismissed with "keep running"', () => {
    render(<ExecutionDetailClient execution={makeExecution({ status: 'running' })} initialLogs={[]} />);
    fireEvent.click(screen.getByRole('button', { name: d.cancelExecution }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: d.cancelDialogKeep }));
    expect(cancelMutate).not.toHaveBeenCalled();
  });

  it('toasts success and failure from the mutation callbacks', () => {
    render(<ExecutionDetailClient execution={makeExecution({ status: 'running' })} initialLogs={[]} />);
    fireEvent.click(screen.getByRole('button', { name: d.cancelExecution }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: d.cancelDialogConfirm }));

    const [, callbacks] = cancelMutate.mock.calls[0] as [string, { onSuccess: () => void; onError: () => void }];
    callbacks.onSuccess();
    expect(toastSuccess).toHaveBeenCalledWith(d.toasts.cancelled);
    callbacks.onError();
    expect(toastError).toHaveBeenCalledWith(d.toasts.cancelFailed);
  });

  it('disables the Cancel button while the request is pending', () => {
    cancelPending = true;
    render(<ExecutionDetailClient execution={makeExecution({ status: 'running' })} initialLogs={[]} />);
    expect((screen.getByRole('button', { name: d.cancelExecution }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers no Cancel on a finished run', () => {
    render(<ExecutionDetailClient execution={makeExecution({ status: 'completed' })} initialLogs={[]} />);
    expect(screen.queryByRole('button', { name: d.cancelExecution })).toBeNull();
  });
});

describe('ExecutionDetailClient: Retry', () => {
  beforeEach(() => {
    retryMutate.mockReset();
    toastSuccess.mockClear();
    push.mockClear();
  });

  it('warns that already-successful steps will run again and only retries once confirmed', () => {
    const execution = makeExecution({
      status: 'failed',
      steps: [step('s1', 'Send notification', 'success'), step('s2', 'Create task', 'failed')],
    });
    render(<ExecutionDetailClient execution={execution} initialLogs={[]} />);

    fireEvent.click(screen.getByRole('button', { name: d.retryExecution }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(d.retryDialogTitle)).toBeTruthy();
    expect(within(dialog).getByText(d.retryDialogDescription)).toBeTruthy();
    expect(
      within(dialog).getByText(d.retryDialogRerunSteps.replace('{count}', '1').replace('{steps}', 'Send notification')),
    ).toBeTruthy();
    expect(retryMutate).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: d.retryDialogConfirm }));
    expect(retryMutate).toHaveBeenCalledWith('wex_abc123456', expect.any(Object));

    const [, callbacks] = retryMutate.mock.calls[0] as [string, { onSuccess: (r: { data: { id: string } }) => void }];
    callbacks.onSuccess({ data: { id: 'wex_new' } });
    expect(toastSuccess).toHaveBeenCalledWith('Retry started');
    expect(push).toHaveBeenCalledWith('/weldconnect/executions/wex_new');
  });

  it('leaves out the step list when nothing succeeded before the failure', () => {
    render(
      <ExecutionDetailClient
        execution={makeExecution({ status: 'failed', steps: [step('s1', 'Create task', 'failed')] })}
        initialLogs={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: d.retryExecution }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(d.retryDialogDescription)).toBeTruthy();
    expect(within(dialog).queryByText(/Already successful/)).toBeNull();
  });
});
