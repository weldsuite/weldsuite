import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/hooks/use-custom-fields', () => ({
  useCustomFields: () => ({
    isLoading: false,
    data: [
      { id: 'cfd_1', entityType: 'employee', name: 'Badge', slug: 'badge', fieldType: 'text', required: false },
      { id: 'cfd_2', entityType: 'employee', name: 'Remote', slug: 'remote', fieldType: 'boolean', required: false },
    ],
  }),
}));

import { CustomFieldsSidebarSection } from './custom-fields-sidebar-section';

describe('CustomFieldsSidebarSection', () => {
  it('lets the viewer edit a value and saves the full map', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CustomFieldsSidebarSection entityType="employee" values={{ badge: 'B-1' }} onSave={onSave} hideHeader />);

    await userEvent.click(screen.getByText('B-1'));
    const input = screen.getByDisplayValue('B-1');
    await userEvent.clear(input);
    await userEvent.type(input, 'B-2{Enter}');

    expect(onSave).toHaveBeenCalledWith({ badge: 'B-2' });
  });

  it('readOnly shows the values without an editor', async () => {
    const onSave = vi.fn();
    render(
      <CustomFieldsSidebarSection entityType="employee" values={{ badge: 'B-1', remote: true }} onSave={onSave} hideHeader readOnly />,
    );

    await userEvent.click(screen.getByText('B-1'));
    expect(screen.queryByDisplayValue('B-1')).not.toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
