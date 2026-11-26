import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PropertyRowLayout, PropertyValue } from './property-row';

afterEach(cleanup);

function Icon({ className }: { className?: string }) {
  return <svg data-testid="icon" className={className} />;
}

describe('PropertyRowLayout', () => {
  it('lays out the icon and label, the value and the accessory in one row', () => {
    const { container } = render(
      <PropertyRowLayout icon={Icon} label="Website" accessory={<button type="button">Copy</button>} className="extra">
        <PropertyValue>https://example.com/a/very/long/path</PropertyValue>
      </PropertyRowLayout>,
    );
    const row = container.querySelector('[data-slot="property-row"]');
    expect(row?.className).toContain('grid-cols-[120px_minmax(0,1fr)_auto]');
    expect(row?.className).toContain('extra');
    expect(screen.getByTestId('icon')).toBeTruthy();
    expect(screen.getByText('Website')).toBeTruthy();
    expect(screen.getByText('https://example.com/a/very/long/path')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('leaves the accessory cell empty without one', () => {
    const { container } = render(
      <PropertyRowLayout icon={Icon} label="Vault">
        <PropertyValue>Personal</PropertyValue>
      </PropertyRowLayout>,
    );
    const cells = container.querySelector('[data-slot="property-row"]')?.children;
    expect(cells).toHaveLength(3);
    expect(cells?.[2]?.textContent).toBe('');
  });
});

describe('PropertyValue', () => {
  it('wraps long values, and sets figures in tabular numerals when asked', () => {
    render(
      <>
        <PropertyValue className="font-mono">plain</PropertyValue>
        <PropertyValue tabular>12 Mar 2026</PropertyValue>
      </>,
    );
    const plain = screen.getByText('plain');
    expect(plain.className).toContain('[overflow-wrap:anywhere]');
    expect(plain.parentElement?.className).toContain('font-mono');
    expect(plain.parentElement?.className).not.toContain('tabular-nums');
    expect(screen.getByText('12 Mar 2026').parentElement?.className).toContain('tabular-nums');
  });
});
