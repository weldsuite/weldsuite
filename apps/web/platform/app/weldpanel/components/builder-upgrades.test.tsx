/**
 * The builders' new options inside a definitions provider: custom events in
 * the event picker (stored as their `@pnce_…` ref, shown by name), computed
 * properties for event properties only, group filters and group breakdowns.
 */

import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelFilter } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { makeLexicon } from '../analytics-fixtures';
import { describeFilter } from '../lib/filters';
import { BreakdownPicker, type BreakdownValue } from './breakdown-picker';
import { PanelDefinitionsProvider } from './definitions';
import { FilterBuilder } from './filter-builder';
import { EventPicker } from './pickers';

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelLexicon: () => ({ data: makeLexicon() }),
  useWeldPanelCohorts: () => ({ data: [] }),
}));
vi.mock('@/hooks/queries/use-weldpanel-analysis-queries', async () => {
  const fixtures = await import('../explore-fixtures');
  return {
    useWeldPanelCustomEvents: () => ({ data: [fixtures.makeCustomEvent()] }),
    useWeldPanelComputedProperties: () => ({ data: [fixtures.makeComputedProperty()] }),
    useWeldPanelGroupTypes: () => ({ data: [fixtures.makeGroupType()] }),
  };
});

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const wrap = (children: ReactNode) => <PanelDefinitionsProvider projectId="wpp_1">{children}</PanelDefinitionsProvider>;
const tf = en.weldpanel.analytics.filters;
const tx = en.weldpanel.explore;

describe('event picker with definitions', () => {
  it('lists custom events by name and stores their ref', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <EventPicker
          projectId="wpp_1"
          value={value}
          ariaLabel="Event"
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(wrap(<Harness />));
    await userEvent.click(screen.getByRole('combobox', { name: 'Event' }));
    expect(screen.getByText(tx.pickers.groupCustomEvents)).toBeTruthy();
    await userEvent.click(screen.getByText('Signed up or invited'));
    expect(onChange).toHaveBeenCalledWith('@pnce_1');
    expect(screen.getByRole('combobox', { name: 'Event' }).textContent).toContain('Signed up or invited');
  });

  it('leaves custom events out where plain names are needed', async () => {
    render(wrap(<EventPicker projectId="wpp_1" value="" onChange={vi.fn()} ariaLabel="Event" allowCustomEvents={false} />));
    await userEvent.click(screen.getByRole('combobox', { name: 'Event' }));
    expect(screen.queryByText('Signed up or invited')).toBeNull();
  });

  it('is unchanged without a provider', async () => {
    render(<EventPicker projectId="wpp_1" value="" onChange={vi.fn()} ariaLabel="Event" />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Event' }));
    expect(screen.queryByText('Signed up or invited')).toBeNull();
  });
});

describe('filter builder with groups', () => {
  it('adds a filter on a property of the event’s group', async () => {
    const onChange = vi.fn();
    render(wrap(<FilterBuilder projectId="wpp_1" filters={[]} onChange={onChange} />));
    await userEvent.click(screen.getByRole('button', { name: tf.add }));
    await userEvent.click(screen.getByRole('combobox', { name: tf.source }));
    await userEvent.click(await screen.findByRole('option', { name: tx.filters.sources.group }));
    await userEvent.click(screen.getByRole('combobox', { name: tf.property }));
    await userEvent.click(await screen.findByText('plan'));
    await userEvent.type(screen.getByLabelText(tf.value), 'pro');
    await userEvent.click(screen.getByRole('button', { name: tf.apply }));
    expect(onChange).toHaveBeenCalledWith([{ source: 'group', groupType: 'company', key: 'plan', operator: 'eq', value: 'pro' }]);
  });

  it('offers computed properties for event properties, by name', async () => {
    const onChange = vi.fn();
    render(wrap(<FilterBuilder projectId="wpp_1" filters={[]} onChange={onChange} />));
    await userEvent.click(screen.getByRole('button', { name: tf.add }));
    await userEvent.click(screen.getByRole('combobox', { name: tf.source }));
    await userEvent.click(await screen.findByRole('option', { name: tf.sources.event }));
    await userEvent.click(screen.getByRole('combobox', { name: tf.property }));
    await userEvent.click(await screen.findByText('Order value'));
    await userEvent.click(screen.getByRole('combobox', { name: tf.operator }));
    await userEvent.click(await screen.findByRole('option', { name: tf.operators.is_set }));
    await userEvent.click(screen.getByRole('button', { name: tf.apply }));
    expect(onChange).toHaveBeenCalledWith([{ source: 'event', key: '@pncp_1', operator: 'is_set', value: undefined }]);
  });

  it('describes group and computed property filters by name', () => {
    const names = { property: (k: string) => (k === '@pncp_1' ? 'Order value' : k), groupType: () => 'Company' };
    const filters: PanelFilter[] = [
      { source: 'group', groupType: 'company', key: 'plan', operator: 'eq', value: 'pro' },
      { source: 'group_key', groupType: 'company', operator: 'eq', value: 'acme' },
      { source: 'event', key: '@pncp_1', operator: 'gt', value: 100 },
    ];
    expect(filters.map((f) => describeFilter(f, tf, names))).toEqual(['Company plan is pro', 'Company is acme', 'Order value is greater than 100']);
  });
});

describe('breakdown picker', () => {
  it('splits by a group property in buckets', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<BreakdownValue | undefined>(undefined);
      return (
        <BreakdownPicker
          projectId="wpp_1"
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(wrap(<Harness />));
    await userEvent.click(screen.getByRole('combobox', { name: en.weldpanel.analytics.breakdown.label }));
    await userEvent.click(await screen.findByRole('option', { name: tx.breakdown.groupSource }));
    expect(onChange).toHaveBeenLastCalledWith({ source: 'group', groupType: 'company', key: '', limit: 10 });
    await userEvent.click(screen.getByRole('combobox', { name: en.weldpanel.analytics.breakdown.property }));
    await userEvent.click(await screen.findByText('plan'));
    await userEvent.click(screen.getByRole('combobox', { name: tx.breakdown.bucket }));
    await userEvent.click(await screen.findByRole('option', { name: tx.breakdown.bucketModes.custom }));
    await userEvent.type(screen.getByLabelText(tx.breakdown.bucketEdges), '10, 50');
    expect(onChange).toHaveBeenLastCalledWith({ source: 'group', groupType: 'company', key: 'plan', limit: 10, bucket: { kind: 'custom', edges: [10, 50] } });
  });
});

