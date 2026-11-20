import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';

const m = vi.hoisted(() => ({
  legal: { entityId: 'le_1' as string | null, entities: [] as unknown[], isLoading: false, setEntityId: vi.fn() },
  ready: true,
  reset: vi.fn(),
  setClientEntity: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ marker: 'qc' }) }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: locale } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: locale }) };
});
vi.mock('@/hooks/queries/use-accounting-queries', () => ({ resetEntityScopedAccountingQueries: m.reset }));
vi.mock('@/hooks/use-current-legal-entity', () => ({ useCurrentLegalEntity: () => m.legal }));
vi.mock('@/lib/api/weldbooks-client', () => ({ setWeldbooksEntityId: m.setClientEntity }));
vi.mock('@/app/weldbooks/settings/entity-scope', () => ({ useSelectWeldbooksEntity: () => m.ready }));
// Radix Select needs pointer APIs jsdom lacks: use a native select with the same props.
vi.mock('@weldsuite/ui/components/select', async () => {
  const React = await import('react');
  const Ctx = React.createContext<{ value?: string; onValueChange?: (v: string) => void }>({});
  return {
    Select: ({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children: React.ReactNode }) => (
      <Ctx.Provider value={{ value, onValueChange }}>{children}</Ctx.Provider>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => {
      const ctx = React.useContext(Ctx);
      return (
        <select aria-label="entity" value={ctx.value ?? ''} onChange={(e) => ctx.onValueChange?.(e.target.value)}>
          {children}
        </select>
      );
    },
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
  };
});

import { WeldbooksSettingsScope } from './entity-scope';

const ts = en.weldbooksUs.settingsPage.entity;

describe('WeldbooksSettingsScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.ready = true;
    m.legal = {
      entityId: 'le_1',
      entities: [
        { id: 'le_1', name: 'Acme Inc', isActive: true },
        { id: 'le_2', name: 'Acme LLC', isActive: true },
        { id: 'le_3', name: 'Old Co', isActive: false },
      ],
      isLoading: false,
      setEntityId: vi.fn(),
    };
  });

  it('shows a loader while the entities load', () => {
    m.legal = { ...m.legal, isLoading: true };
    render(<WeldbooksSettingsScope>child content</WeldbooksSettingsScope>);
    expect(screen.queryByText('child content')).toBeNull();
    expect(screen.queryByText(ts.none)).toBeNull();
  });

  it('says so when there is no active entity', () => {
    m.legal = { ...m.legal, entities: [{ id: 'le_3', name: 'Old Co', isActive: false }] };
    render(<WeldbooksSettingsScope>child content</WeldbooksSettingsScope>);
    expect(screen.getByText(ts.none)).toBeTruthy();
    expect(screen.queryByText('child content')).toBeNull();
  });

  it('says so when no entity is selected', () => {
    m.legal = { ...m.legal, entityId: null };
    render(<WeldbooksSettingsScope>child content</WeldbooksSettingsScope>);
    expect(screen.getByText(ts.none)).toBeTruthy();
  });

  it('shows the picker with active entities only, and the children once the client points at the entity', () => {
    render(<WeldbooksSettingsScope>child content</WeldbooksSettingsScope>);
    expect(screen.getByText(ts.label)).toBeTruthy();
    expect(screen.getByText(ts.hint)).toBeTruthy();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Acme Inc', 'Acme LLC']);
    expect((screen.getByLabelText('entity') as HTMLSelectElement).value).toBe('le_1');
    expect(screen.getByText('child content')).toBeTruthy();
  });

  it('holds the children back while the client switches entity', () => {
    m.ready = false;
    render(<WeldbooksSettingsScope>child content</WeldbooksSettingsScope>);
    expect(screen.getByText(ts.label)).toBeTruthy();
    expect(screen.queryByText('child content')).toBeNull();
  });

  it('switches entity: points the client at it and drops the previous results', () => {
    render(<WeldbooksSettingsScope>child content</WeldbooksSettingsScope>);
    fireEvent.change(screen.getByLabelText('entity'), { target: { value: 'le_2' } });
    expect(m.setClientEntity).toHaveBeenCalledWith('le_2');
    expect(m.legal.setEntityId).toHaveBeenCalledWith('le_2');
    expect(m.reset).toHaveBeenCalledWith({ marker: 'qc' });
  });

  it('ignores re-selecting the current entity', () => {
    render(<WeldbooksSettingsScope>child content</WeldbooksSettingsScope>);
    fireEvent.change(screen.getByLabelText('entity'), { target: { value: 'le_1' } });
    expect(m.setClientEntity).not.toHaveBeenCalled();
    expect(m.reset).not.toHaveBeenCalled();
  });
});
