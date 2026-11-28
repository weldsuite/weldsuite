import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AvatarStack, SendArrowIcon, readableOn, timeAgo } from './parts';
import { DAAN, SOPHIE } from '@/__tests__/fixtures';

const PRIYA = { name: 'Priya Shah', avatar: null };

describe('AvatarStack', () => {
  it('overlaps each face 8px by default', () => {
    render(<AvatarStack team={[SOPHIE, DAAN]} size={28} />);
    expect(screen.getByLabelText('Sophie Bakker').style.marginLeft).toBe('0px');
    expect(screen.getByLabelText('Daan de Vries').style.marginLeft).toBe('-8px');
  });

  it('takes its own overlap, size and ring, and shows three faces at most', () => {
    render(<AvatarStack team={[SOPHIE, DAAN, PRIYA, { name: 'Extra', avatar: null }]} size={40} ring="rgb(14, 12, 11)" overlap={2} />);
    const daan = screen.getByLabelText('Daan de Vries');
    expect(daan.style.marginLeft).toBe('-2px');
    expect(daan.style.width).toBe('40px');
    expect(daan.style.boxShadow).toContain('rgb(14, 12, 11)');
    expect(screen.queryByLabelText('Extra')).toBeNull();
  });

  it('renders nothing without a team', () => {
    const { container } = render(<AvatarStack team={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('SendArrowIcon', () => {
  it('is decorative and takes the colour around it', () => {
    const { container } = render(<SendArrowIcon className="extra" style={{ color: 'red' }} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('fill')).toBe('currentColor');
    expect(svg?.getAttribute('class')).toContain('extra');
    expect(svg?.style.color).toBe('red');
  });
});

describe('readableOn', () => {
  it('picks white on dark brand colours and near-black on light ones', () => {
    expect(readableOn('#4f46e5')).toBe('#ffffff');
    expect(readableOn('#fde68a')).toBe('#111827');
    expect(readableOn('#fff')).toBe('#111827');
  });
});

describe('timeAgo', () => {
  it('is empty without a time and short otherwise', () => {
    expect(timeAgo(null)).toBe('');
    expect(timeAgo(new Date().toISOString())).toBe('now');
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m');
  });
});
