import { createContext, useContext, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type {
  ConnectorFieldMapping,
  ConnectorFieldMappingDefinition,
  ConnectorSyncDef,
} from '@/hooks/queries/use-connector-queries';

vi.mock('@/lib/i18n/provider', async () => {
  const locale = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: locale.en, language: 'en', format: interpolate }) };
});

interface SelectState {
  value?: string;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
}

// Radix Select needs pointer APIs jsdom lacks: every option is a plain button instead.
const SelectContext = createContext<SelectState>({});
vi.mock('@weldsuite/ui/components/select', () => ({
  Select: ({ children, ...state }: SelectState & { children: ReactNode }) => (
    <SelectContext.Provider value={state}>
      <div data-testid="select" data-value={state.value} data-disabled={state.disabled ? 'true' : 'false'}>
        {children}
      </div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: function SelectItem({ value, children }: { value: string; children: ReactNode }) {
    const state = useContext(SelectContext);
    return (
      <button type="button" role="option" aria-selected={state.value === value} onClick={() => state.onValueChange?.(value)}>
        {children}
      </button>
    );
  },
}));

const { toast, state } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  state: {
    isLoading: false,
    saving: false,
    mappings: {} as Record<string, { data: unknown[] }>,
    defaults: {} as Record<string, { data: unknown[] } | undefined>,
    mappingCalls: [] as Array<[string | null, string | undefined]>,
    mutateAsync: vi.fn(),
  },
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/queries/use-connector-queries', () => ({
  useConnectorFieldMappings: (connectionId: string | null, entityType?: string) => {
    state.mappingCalls.push([connectionId, entityType]);
    return { data: state.mappings[entityType ?? ''], isLoading: state.isLoading };
  },
  useConnectorDefaultFieldMappings: (_connectionId: string | null, entityType: string) => ({
    data: state.defaults[entityType],
  }),
  useUpdateConnectorFieldMappings: () => ({ mutateAsync: state.mutateAsync, isPending: state.saving }),
}));

import { ConnectorFieldMappingEditor } from './connector-field-mapping-editor';

const tc = en.settings.integrations.connectors;

function sync(internalEntity: string): ConnectorSyncDef {
  return { syncName: `${internalEntity}-sync`, model: internalEntity, internalEntity, settingKey: internalEntity };
}

function stored(
  externalFieldPath: string,
  internalFieldPath: string,
  direction: ConnectorFieldMapping['direction'] = 'bidirectional',
): ConnectorFieldMapping {
  return {
    id: `fm_${externalFieldPath}`,
    connectionId: 'cc_1',
    entityType: 'product',
    externalFieldPath,
    internalFieldPath,
    direction,
    transformType: 'direct',
    transformConfig: null,
    isRequired: false,
    isDefault: false,
    position: 0,
  };
}

function definition(externalFieldPath: string, internalFieldPath: string): ConnectorFieldMappingDefinition {
  return { externalFieldPath, internalFieldPath, direction: 'inbound', transformType: 'direct', isRequired: true };
}

function renderEditor(syncs: ConnectorSyncDef[] = [sync('product')], canManage = true) {
  const ui = (list: ConnectorSyncDef[]) => (
    <ConnectorFieldMappingEditor connectionId="cc_1" syncs={list} canManage={canManage} />
  );
  const result = render(ui(syncs));
  return { ...result, rerenderWith: (list: ConnectorSyncDef[]) => result.rerender(ui(list)) };
}

/** The select at a position: rows are laid out as external, internal, external, internal… */
function selectAt(index: number): HTMLElement {
  return screen.getAllByTestId('select')[index]!;
}

function choose(select: HTMLElement, optionName: string): void {
  fireEvent.click(within(select).getByRole('option', { name: optionName }));
}

describe('ConnectorFieldMappingEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.isLoading = false;
    state.saving = false;
    state.mappingCalls = [];
    state.mappings = {
      product: { data: [stored('name', 'name', 'inbound'), stored('sku', 'sku', 'outbound')] },
      order: { data: [] },
    };
    state.defaults = { product: { data: [definition('title', 'name')] } };
    state.mutateAsync.mockResolvedValue({ data: { entityType: 'product', count: 1 } });
  });

  it('shows a spinner and no mappings while they load', () => {
    state.isLoading = true;
    renderEditor();
    expect(screen.queryByRole('button', { name: tc.settings.mappingsAdd })).toBeNull();
    expect(screen.queryAllByTestId('select')).toHaveLength(0);
  });

  it('lists the stored mappings with their fields and directions', () => {
    renderEditor();
    expect(screen.getAllByTestId('select').map((el) => el.dataset.value)).toEqual(['name', 'name', 'sku', 'sku']);
    expect(screen.getAllByTitle(tc.settings.directionInbound)).toHaveLength(1);
    expect(screen.getAllByTitle(tc.settings.directionOutbound)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: tc.settings.mappingsSave })).toBeNull();
  });

  it('says so when there are no mappings yet', () => {
    state.mappings.product = { data: [] };
    renderEditor();
    expect(screen.getByText(tc.settings.mappingsEmpty)).toBeTruthy();
  });

  it('adds an empty two-way row and offers to save it', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: tc.settings.mappingsAdd }));
    expect(screen.getAllByTestId('select')).toHaveLength(6);
    expect(selectAt(4).dataset.value).toBe('');
    expect(screen.getAllByTitle(tc.settings.directionBidirectional)).toHaveLength(1);
    expect(screen.getByRole('button', { name: tc.settings.mappingsSave })).toBeTruthy();
  });

  it('removes a row', () => {
    renderEditor();
    const removeButtons = screen.getAllByRole('button').filter((button) => button.querySelector('.lucide-trash-2'));
    fireEvent.click(removeButtons[0]!);
    expect(screen.getAllByTestId('select').map((el) => el.dataset.value)).toEqual(['sku', 'sku']);
    expect(screen.getByRole('button', { name: tc.settings.mappingsSave })).toBeTruthy();
  });

  it('lets the person pick another external and internal field for a row', async () => {
    renderEditor();
    choose(selectAt(0), 'Title');
    choose(selectAt(1), tc.mappingFields.price);
    expect(selectAt(0).dataset.value).toBe('title');
    expect(selectAt(1).dataset.value).toBe('price');

    fireEvent.click(screen.getByRole('button', { name: tc.settings.mappingsSave }));
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    const [input] = state.mutateAsync.mock.calls[0] as [{ mappings: Array<Record<string, unknown>> }];
    expect(input.mappings[0]).toMatchObject({ externalFieldPath: 'title', internalFieldPath: 'price' });
    expect(input.mappings[1]).toMatchObject({ externalFieldPath: 'sku', internalFieldPath: 'sku' });
  });

  it('cycles a row through two-way, one-way in and one-way out', () => {
    state.mappings.product = { data: [stored('name', 'name', 'bidirectional')] };
    renderEditor();
    fireEvent.click(screen.getByTitle(tc.settings.directionBidirectional));
    expect(screen.getByTitle(tc.settings.directionInbound)).toBeTruthy();
    fireEvent.click(screen.getByTitle(tc.settings.directionInbound));
    expect(screen.getByTitle(tc.settings.directionOutbound)).toBeTruthy();
    fireEvent.click(screen.getByTitle(tc.settings.directionOutbound));
    expect(screen.getByTitle(tc.settings.directionBidirectional)).toBeTruthy();
  });

  it('saves the edited mappings for the shown object and confirms it', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: tc.settings.mappingsAdd }));
    fireEvent.click(screen.getByRole('button', { name: tc.settings.mappingsSave }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(tc.settings.mappingsSaved));
    expect(state.mutateAsync).toHaveBeenCalledWith({
      connectionId: 'cc_1',
      entityType: 'product',
      mappings: [
        expect.objectContaining({ externalFieldPath: 'name', direction: 'inbound' }),
        expect.objectContaining({ externalFieldPath: 'sku', direction: 'outbound' }),
        { externalFieldPath: '', internalFieldPath: '', direction: 'bidirectional', transformType: 'direct' },
      ],
    });
    expect(screen.queryByRole('button', { name: tc.settings.mappingsSave })).toBeNull();
  });

  it('keeps the save button and reports a failed save', async () => {
    state.mutateAsync.mockRejectedValue(new Error('boom'));
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: tc.settings.mappingsAdd }));
    fireEvent.click(screen.getByRole('button', { name: tc.settings.mappingsSave }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(tc.settings.mappingsSaveFailed));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: tc.settings.mappingsSave })).toBeTruthy();
  });

  it('disables the save button while a save is running', () => {
    state.saving = true;
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: tc.settings.mappingsAdd }));
    expect((screen.getByRole('button', { name: tc.settings.mappingsSave }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('replaces the rows with the defaults, to be saved', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: tc.settings.mappingsDefaults }));
    expect(screen.getAllByTestId('select').map((el) => el.dataset.value)).toEqual(['title', 'name']);
    expect(screen.getAllByTitle(tc.settings.directionInbound)).toHaveLength(1);
    expect(screen.getByRole('button', { name: tc.settings.mappingsSave })).toBeTruthy();
  });

  it('does nothing on Defaults while the defaults have not loaded', () => {
    state.defaults = {};
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: tc.settings.mappingsDefaults }));
    expect(screen.getAllByTestId('select')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: tc.settings.mappingsSave })).toBeNull();
  });

  it('shows one tab per distinct object, and loads the mappings of the tab picked', () => {
    state.mappings.order = { data: [stored('number', 'orderNumber')] };
    renderEditor([sync('product'), sync('order'), sync('order'), sync('widget')]);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([tc.types.products, tc.types.orders, 'widget']);

    fireEvent.mouseDown(screen.getByRole('tab', { name: tc.types.orders }));
    expect(state.mappingCalls.at(-1)).toEqual(['cc_1', 'order']);
    expect(screen.getAllByTestId('select').map((el) => el.dataset.value)).toEqual(['number', 'orderNumber']);
  });

  it('falls back to the first object when the shown one is no longer synced', () => {
    const { rerenderWith } = renderEditor([sync('product')]);
    rerenderWith([sync('order')]);
    expect(state.mappingCalls.at(-1)).toEqual(['cc_1', 'order']);
  });

  it('is read-only for someone who cannot manage the connection', () => {
    renderEditor([sync('product')], false);
    expect(screen.queryByRole('button', { name: tc.settings.mappingsAdd })).toBeNull();
    expect(screen.getAllByTestId('select').every((el) => el.dataset.disabled === 'true')).toBe(true);
    expect((screen.getByRole('button', { name: tc.settings.mappingsDefaults }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle(tc.settings.directionInbound) as HTMLButtonElement).disabled).toBe(true);
  });
});
