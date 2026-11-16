import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiModelOption } from '@weldsuite/app-api-client/schemas/ai-settings';

const state = vi.hoisted(() => ({ models: null as AiModelOption[] | null }));
vi.mock('@/hooks/queries/use-ai-settings-queries', () => ({
  useAiModelOptions: () => state.models,
}));

import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/banking/feeds/test-support';
import { AiStepModelInput } from './action-config-form';

beforeAll(installPointerPolyfills);
beforeEach(() => {
  state.models = null;
});

describe('WeldConnect AI step model picker', () => {
  it('stays a free-text model id where there are no AI settings (Global)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<AiStepModelInput value={undefined} onChange={onChange} placeholder="Recommended default" />);
    await user.type(screen.getByPlaceholderText('Recommended default'), 'x');
    expect(onChange).toHaveBeenLastCalledWith('x');
  });

  it('lists the models of the workspace for connect, with their region, on a Kubernetes install', async () => {
    state.models = [
      {
        id: 'mistral/mistral-medium',
        provider: 'mistral',
        region: 'eu',
        label: 'Mistral Medium',
      },
      {
        id: 'anthropic/claude-sonnet-5-5',
        provider: 'anthropic',
        region: 'outside-eu',
        label: 'Claude Sonnet',
      },
    ];
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<AiStepModelInput value={undefined} onChange={onChange} placeholder="" />);
    await user.click(screen.getByRole('combobox'));
    expect(await screen.findByRole('option', { name: /Mistral Medium/ })).toHaveTextContent('processed in the EU');
    const claude = screen.getByRole('option', { name: /Claude Sonnet/ });
    expect(claude).toHaveTextContent('outside the EU');
    await user.click(claude);
    expect(onChange).toHaveBeenCalledWith('anthropic/claude-sonnet-5-5');
  });

  it("clears the step's model when the workspace default is picked", async () => {
    state.models = [
      {
        id: 'anthropic/claude-sonnet-5-5',
        provider: 'anthropic',
        region: 'outside-eu',
        label: 'Claude Sonnet',
      },
    ];
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<AiStepModelInput value="anthropic/claude-sonnet-5-5" onChange={onChange} placeholder="" />);
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Use the workspace default' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
