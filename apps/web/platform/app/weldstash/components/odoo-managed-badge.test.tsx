import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OdooManagedBadge } from './odoo-managed-badge';

describe('OdooManagedBadge', () => {
  it('says the stock is managed in Odoo and explains why on hover', () => {
    render(<OdooManagedBadge className="extra" />);
    const badge = screen.getByText('Managed in Odoo');
    expect(badge.closest('[title]')).toHaveAttribute('title', expect.stringContaining('synced from Odoo'));
  });
});
