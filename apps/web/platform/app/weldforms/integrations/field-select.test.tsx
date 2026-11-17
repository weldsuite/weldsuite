import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { FieldSelect, fieldsOfTypes } from './field-select';

vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en }) }));
vi.mock('@weldsuite/ui/components/info-tooltip', () => ({ InfoTooltip: ({ content }: { content: string }) => <span data-testid="info">{content}</span> }));

afterEach(cleanup);

const empty = { blocks: [] };

describe('FieldSelect', () => {
  it('shows an info tooltip only when a hint is set', () => {
    render(<FieldSelect id="a" label="Label" hint="Some hint" definition={empty} value={undefined} onChange={vi.fn()} />);
    expect(screen.getByTestId('info').textContent).toBe('Some hint');
    cleanup();
    render(<FieldSelect id="a" label="Label" definition={empty} value={undefined} onChange={vi.fn()} />);
    expect(screen.queryByTestId('info')).toBeNull();
  });

  it('tells when the form has no questions', () => {
    render(<FieldSelect id="a" label="Label" definition={empty} value={undefined} onChange={vi.fn()} noneLabel="None" placeholder="Pick" />);
    expect(screen.getByText(en.weldformsResults.integrations.noFields)).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
  });
});

describe('fieldsOfTypes', () => {
  it('returns no fields for an empty definition, filtered or not', () => {
    expect(fieldsOfTypes(empty)).toEqual([]);
    expect(fieldsOfTypes(empty, ['email'])).toEqual([]);
  });
});
