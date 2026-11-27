import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { widgetConfig } from '@/__tests__/fixtures';
import { SignInRequired } from './sign-in-required';

describe('SignInRequired', () => {
  it('asks the visitor to sign in and closes from a 34px button with an 18px icon', () => {
    const onClose = vi.fn();
    render(<SignInRequired config={widgetConfig()} onClose={onClose} />);
    expect(screen.getByText('Sign in to chat with us')).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.className).toContain('p-2');
    expect(close.querySelector('svg')?.getAttribute('class')).toContain('h-[18px]');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('has no close button when the page can not close it', () => {
    render(<SignInRequired config={widgetConfig()} />);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
