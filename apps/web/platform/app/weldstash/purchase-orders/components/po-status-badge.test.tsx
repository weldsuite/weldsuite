import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PoStatusBadge } from './po-status-badge';

describe('PoStatusBadge', () => {
  it('shows the translated label of a known status', () => {
    render(<PoStatusBadge status="partial" />);
    expect(screen.getByText('Partly received')).toBeInTheDocument();
  });

  it('shows an unknown status as it is', () => {
    render(<PoStatusBadge status="on_hold" />);
    expect(screen.getByText('on_hold')).toBeInTheDocument();
  });
});
