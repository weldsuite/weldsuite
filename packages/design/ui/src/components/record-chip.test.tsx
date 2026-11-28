import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RecordChip } from './record-chip';

describe('RecordChip', () => {
  afterEach(cleanup);

  it('renders a real link named by its label, secondary text and status', () => {
    render(
      <RecordChip label="INV-0042" secondary="1.200,00" tone="success" statusLabel="Paid" href="/x?stack=invoice:1" />,
    );
    const link = screen.getByRole('link', { name: /INV-0042/ });
    expect(link.getAttribute('href')).toBe('/x?stack=invoice:1');
    expect(link.textContent).toContain('1.200,00');
    expect(link.textContent).toContain('Paid');
  });

  it('opens in place on a plain click and cancels the navigation', () => {
    const onOpen = vi.fn();
    render(<RecordChip label="INV-1" href="#inv-1" onOpen={onOpen} />);
    const notPrevented = fireEvent.click(screen.getByRole('link'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it('keeps the browser default for Cmd, Ctrl, Shift and middle clicks', () => {
    const onOpen = vi.fn();
    render(<RecordChip label="INV-1" href="#inv-1" onOpen={onOpen} />);
    const link = screen.getByRole('link');
    expect(fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(link, { shiftKey: true })).toBe(true);
    expect(fireEvent.click(link, { button: 1 })).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not trigger a clickable row around it', () => {
    const onRow = vi.fn();
    const onRowAux = vi.fn();
    render(
      <div role="presentation" onClick={onRow} onAuxClick={onRowAux}>
        <RecordChip label="INV-1" href="#inv-1" onOpen={() => undefined} />
      </div>,
    );
    const link = screen.getByRole('link');
    fireEvent.click(link);
    fireEvent.click(link, { metaKey: true });
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(onRow).not.toHaveBeenCalled();
    expect(onRowAux).not.toHaveBeenCalled();
  });

  it('falls back to a button without an href', () => {
    const onOpen = vi.fn();
    render(<RecordChip label="Acme" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Acme' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
