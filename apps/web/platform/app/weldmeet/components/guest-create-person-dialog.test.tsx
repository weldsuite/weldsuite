import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mutateAsync = vi.fn();
const resolvePersonByEmail = vi.fn();

vi.mock('@/hooks/queries/use-people-queries', () => ({
  useCreatePerson: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('./use-resolve-person-by-email', () => ({
  useResolvePersonByEmail: () => resolvePersonByEmail,
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { GuestCreatePersonDialog } from './guest-create-person-dialog';

const SAVE = 'Save person';

/** Current value of the labelled text field. */
function fieldValue(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

function renderDialog(target: { name?: string; email?: string } | null) {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  render(<GuestCreatePersonDialog target={target} onOpenChange={onOpenChange} onCreated={onCreated} />);
  return { onCreated, onOpenChange };
}

beforeEach(() => {
  mutateAsync.mockReset();
  resolvePersonByEmail.mockReset();
});

describe('GuestCreatePersonDialog', () => {
  it('prefills the name and the known guest email', () => {
    renderDialog({ name: 'Jane Doe', email: 'jane@example.com' });

    expect(fieldValue('First name')).toBe('Jane');
    expect(fieldValue('Last name')).toBe('Doe');
    expect(fieldValue('Email (optional)')).toBe('jane@example.com');
  });

  it('leaves the email empty when the guest has none', () => {
    renderDialog({ name: 'Jane Doe' });

    expect(fieldValue('Email (optional)')).toBe('');
  });

  it('opens the existing person instead of creating a duplicate', async () => {
    resolvePersonByEmail.mockResolvedValue('per_existing');
    const { onCreated } = renderDialog({ name: 'Jane Doe', email: 'jane@example.com' });

    fireEvent.click(screen.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('per_existing'));
    expect(resolvePersonByEmail).toHaveBeenCalledWith('jane@example.com');
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('creates the person when the email is not known yet', async () => {
    resolvePersonByEmail.mockResolvedValue(null);
    mutateAsync.mockResolvedValue({ data: { id: 'per_new' } });
    const { onCreated } = renderDialog({ name: 'Jane Doe', email: 'jane@example.com' });

    fireEvent.click(screen.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('per_new'));
    expect(mutateAsync).toHaveBeenCalledWith({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
    });
  });

  it('still creates the person when the lookup itself fails', async () => {
    resolvePersonByEmail.mockRejectedValue(new Error('network down'));
    mutateAsync.mockResolvedValue({ data: { id: 'per_new' } });
    const { onCreated } = renderDialog({ name: 'Jane Doe', email: 'jane@example.com' });

    fireEvent.click(screen.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('per_new'));
  });

  it('skips the lookup when no email was entered', async () => {
    mutateAsync.mockResolvedValue({ data: { id: 'per_new' } });
    const { onCreated } = renderDialog({ name: 'Jane Doe' });

    fireEvent.click(screen.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('per_new'));
    expect(resolvePersonByEmail).not.toHaveBeenCalled();
  });
});
