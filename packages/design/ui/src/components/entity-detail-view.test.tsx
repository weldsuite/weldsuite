import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_UI_LABELS, UiLabelsProvider } from '../providers/ui-labels-provider';
import { EntityDetailView } from './entity-detail-view';

afterEach(cleanup);

describe('EntityDetailView back placement', () => {
  it('puts the back button before the avatar by default', () => {
    render(
      <EntityDetailView onBack={vi.fn()} onClose={vi.fn()} avatar={<span data-testid="avatar" />} title="Acme">
        <p>Body</p>
      </EntityDetailView>,
    );
    const back = screen.getByRole('button', { name: 'Back' });
    const avatar = screen.getByTestId('avatar');
    // Same row, back first.
    expect(back.parentElement).toBe(avatar.parentElement?.parentElement);
    expect(back.compareDocumentPosition(avatar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts the back button on its own row above, with the row actions, in the labels language', () => {
    const onBack = vi.fn();
    render(
      <UiLabelsProvider labels={{ ...DEFAULT_UI_LABELS, back: 'Terug naar logins' }}>
        <EntityDetailView
          onBack={onBack}
          onClose={vi.fn()}
          backPlacement="above"
          backRowActions={<button type="button">Open site</button>}
          avatar={<span data-testid="avatar" />}
          title="Acme"
        >
          <p>Body</p>
        </EntityDetailView>
      </UiLabelsProvider>,
    );
    const back = screen.getByRole('button', { name: 'Terug naar logins' });
    const avatar = screen.getByTestId('avatar');
    // Not in the avatar's row: that row starts with the avatar.
    const avatarRow = avatar.parentElement?.parentElement;
    expect(avatarRow?.firstElementChild).toBe(avatar.parentElement);
    expect(avatarRow?.contains(back)).toBe(false);
    expect(screen.getByRole('button', { name: 'Open site' })).toBeTruthy();
    expect(back.compareDocumentPosition(avatar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('keeps the back button inline when there is nothing to go back to', () => {
    render(
      <EntityDetailView onClose={vi.fn()} backPlacement="above" backRowActions={<button type="button">Open site</button>} title="Acme">
        <p>Body</p>
      </EntityDetailView>,
    );
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open site' })).toBeNull();
  });
});
