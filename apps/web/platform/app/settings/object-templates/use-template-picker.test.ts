import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/hooks/queries/use-object-templates-queries', () => ({
  useObjectTemplates: () => ({ data: [] }),
}));

vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useCustomFields: () => ({
    data: [
      { id: 'cf1', slug: 'region', name: 'Region', fieldType: 'text', entityType: 'company', required: false },
      { id: 'cf2', slug: 'tier', name: 'Tier', fieldType: 'single_select', entityType: 'company', required: false },
      { id: 'cf3', slug: 'vip', name: 'VIP', fieldType: 'boolean', entityType: 'company', required: false },
    ],
  }),
}));

import { useTemplatePicker } from './use-template-picker';

describe('useTemplatePicker', () => {
  it('shows every workspace custom field on the default tab, after the built-in defaults', () => {
    const { result } = renderHook(() => useTemplatePicker('company'));
    expect(result.current.visibleSlugs).toEqual([
      'name',
      'email',
      'website',
      'industry',
      'cf:region',
      'cf:tier',
      'cf:vip',
    ]);
  });

  it('buildPayload keeps booleans/numbers and drops empty values', () => {
    const { result } = renderHook(() => useTemplatePicker('company'));
    const payload = result.current.buildPayload({
      name: 'Acme',
      email: '',
      customFields: { region: 'EU', tier: '', vip: false, multi: [] },
    });
    expect(payload).toEqual({ name: 'Acme', customFields: { region: 'EU', vip: false } });
  });
});
