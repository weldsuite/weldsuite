import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LockedButton } from './locked-button';

describe('LockedButton', () => {
  afterEach(cleanup);

  it('is an ordinary button without a reason', () => {
    const onClick = vi.fn();
    render(<LockedButton onClick={onClick}>Edit</LockedButton>);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Edit' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('stays focusable, does nothing and says why while it is locked', () => {
    const onClick = vi.fn();
    render(
      <LockedButton lockedReason="These hours are on an invoice." onClick={onClick}>
        Edit
      </LockedButton>,
    );
    const button = screen.getByRole('button', { name: /Edit/ });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // Not natively disabled: a disabled button leaves the tab order and cannot explain itself.
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    expect(button.textContent).toContain('These hours are on an invoice.');
  });

  it('is natively disabled for a reason that needs no explanation', () => {
    render(<LockedButton disabled>Delete</LockedButton>);
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
