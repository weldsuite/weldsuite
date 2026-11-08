import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { EmployerField } from './employer-field';

const state = vi.hoisted(() => ({ current: null as string | null }));
const entities = [
  { id: 'ent_1', name: 'Acme BV' },
  { id: 'ent_2', name: 'Beta Inc' },
];

vi.mock('@/hooks/use-current-legal-entity', () => ({
  useCurrentLegalEntity: () => ({
    entityId: state.current,
    entity: entities.find((e) => e.id === state.current),
    entities,
  }),
}));
vi.mock('@/components/legal-entity/legal-entity-picker', () => ({
  LegalEntityPicker: () => <div data-testid="entity-picker" />,
}));

const t = en.weldhr.employees.create;

function renderField(lockToCurrent: boolean) {
  return render(
    <I18nProvider initialLanguage="en">
      <EmployerField value={undefined} onChange={vi.fn()} lockToCurrent={lockToCurrent} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  state.current = 'ent_2';
});

describe('EmployerField on create', () => {
  it('shows the current entity read-only with the switch hint', () => {
    renderField(true);
    const input = screen.getByLabelText(t.employer) as HTMLInputElement;
    expect(input.value).toBe('Beta Inc');
    expect(input.readOnly).toBe(true);
    expect(screen.queryByTestId('entity-picker')).toBeNull();
    expect(screen.getByText(t.employerLockedHint)).toBeTruthy();
  });

  it('keeps the picker when no entity is current (no header is sent)', () => {
    state.current = null;
    renderField(true);
    expect(screen.getByTestId('entity-picker')).toBeTruthy();
  });

  it('keeps the picker on the edit form', () => {
    renderField(false);
    expect(screen.getByTestId('entity-picker')).toBeTruthy();
  });
});
