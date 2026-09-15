import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { User, Settings } from 'lucide-react';
import { ColoredSquareIcon } from './colored-square-icon';
import { findColoredSquareIconByLabel, coloredSquareIcons } from '@/components/app-sidebar-layout';

describe('ColoredSquareIcon', () => {
  it('renders a readable glyph inside the colored square', () => {
    const { container } = render(
      <ColoredSquareIcon icon={User} color="bg-blue-500" />,
    );

    const square = container.firstElementChild as HTMLElement;
    expect(square).toHaveClass('size-5', 'bg-blue-500');

    const glyph = square.querySelector('svg');
    expect(glyph).toHaveClass('size-3.5', 'text-white');
  });

  it('falls back to gray when no color is provided', () => {
    const { container } = render(<ColoredSquareIcon icon={Settings} />);
    expect(container.firstElementChild).toHaveClass('bg-gray-500');
  });
});

describe('findColoredSquareIconByLabel', () => {
  it('resolves labels case-insensitively', () => {
    expect(findColoredSquareIconByLabel('settings')).toBe(Settings);
    expect(findColoredSquareIconByLabel('Settings')).toBe(Settings);
    expect(findColoredSquareIconByLabel('  USER  ')).toBe(User);
  });

  it('includes the expanded palette icons', () => {
    const labels = coloredSquareIcons.map((i) => i.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Settings', 'Mobile', 'Chat', 'Calculator', 'Idea', 'Code', 'Hash', 'Rocket']),
    );
  });

  it('returns undefined for unknown labels', () => {
    expect(findColoredSquareIconByLabel('')).toBeUndefined();
    expect(findColoredSquareIconByLabel('NotARealIcon')).toBeUndefined();
  });
});
