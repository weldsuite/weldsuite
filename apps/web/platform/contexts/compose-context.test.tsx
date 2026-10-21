import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ComposeProvider, useComposeSafe } from './compose-context';

/** Opens a mail, like the email button on a CRM record. */
function OpenButton() {
  const compose = useComposeSafe();
  return (
    <button type="button" onClick={() => compose?.openCompose({ to: 'daniel@example.com' })}>
      open
    </button>
  );
}

/** Reads the mail, like WeldMail's full-page compose. */
function Recipient() {
  const compose = useComposeSafe();
  return <span data-testid="to">{compose?.composeData.to}</span>;
}

describe('ComposeProvider', () => {
  it('shares an outer provider, so a module layout sees the mail the app shell opened', () => {
    render(
      <ComposeProvider panel={<span data-testid="panel" />}>
        <OpenButton />
        <ComposeProvider panel={<span data-testid="panel" />}>
          <Recipient />
        </ComposeProvider>
      </ComposeProvider>,
    );

    act(() => screen.getByRole('button', { name: 'open' }).click());

    expect(screen.getByTestId('to').textContent).toBe('daniel@example.com');
    // Only the outermost provider renders its floating panel.
    expect(screen.getAllByTestId('panel')).toHaveLength(1);
  });

  it('provides its own state and panel when nothing is around it', () => {
    render(
      <ComposeProvider panel={<span data-testid="panel" />}>
        <OpenButton />
        <Recipient />
      </ComposeProvider>,
    );

    act(() => screen.getByRole('button', { name: 'open' }).click());

    expect(screen.getByTestId('to').textContent).toBe('daniel@example.com');
    expect(screen.getAllByTestId('panel')).toHaveLength(1);
  });
});
